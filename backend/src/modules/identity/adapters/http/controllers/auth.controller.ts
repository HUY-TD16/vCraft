import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Public, Roles, SessionLevels } from '../../../../../common/security/decorators/access-policy';
import { CurrentActor } from '../../../../../common/security/decorators/current-actor.decorator';
import type { AuthenticatedActor, SessionLevel } from '../../../../../common/application/types/contract-types';
import { APP_CONFIG, type AppConfig } from '../../../../../common/config/app-config';
import { IdentityService } from '../../../application/services/identity.service';
import { RegisterBuyerDto } from '../dtos/register-buyer.dto';
import { LoginDto } from '../dtos/login.dto';
import { ChangePasswordDto } from '../dtos/change-password.dto';
import { ChangeTempPasswordDto } from '../dtos/change-temp-password.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly identityService: IdentityService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: Pick<AppConfig, 'NODE_ENV'>,
  ) {}

  private isDevelopment(): boolean {
    return (this.config?.NODE_ENV ?? process.env.NODE_ENV) === 'development';
  }

  private get sessionCookieName(): string {
    return this.isDevelopment() ? 'vcraft-session' : '__Host-vcraft-session';
  }

  private get preauthCookieName(): string {
    return this.isDevelopment() ? 'vcraft-preauth' : '__Host-vcraft-preauth';
  }

  private setSessionCookie(res: Response, token: string, level: SessionLevel): void {
    const isDev = this.isDevelopment();
    const maxAge = level === 'temp_password' ? 15 * 60 * 1000 : 12 * 60 * 60 * 1000;
    res.cookie(this.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: !isDev,
      maxAge,
    });
  }

  private clearSessionCookie(res: Response): void {
    res.clearCookie(this.sessionCookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !this.isDevelopment(),
    });
  }

  @Get('csrf')
  @Public()
  async getCsrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sessionToken = req.cookies?.[this.sessionCookieName];
    if (typeof sessionToken === 'string' && sessionToken) {
      const actor = await this.identityService.resolveSession(sessionToken);
      if (actor) {
        return {
          csrf_token: randomBytes(32).toString('hex'),
          session_level: actor.sessionLevel,
        };
      }
    }

    const preauthName = this.preauthCookieName;
    let preauthToken = req.cookies?.[preauthName];
    if (typeof preauthToken !== 'string' || !preauthToken) {
      preauthToken = randomBytes(32).toString('hex');
      res.cookie(preauthName, preauthToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: !this.isDevelopment(),
        maxAge: 15 * 60 * 1000,
      });
    }

    return {
      csrf_token: preauthToken,
      session_level: 'preauth',
    };
  }

  @Post('register-buyer')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  async registerBuyer(@Body() dto: RegisterBuyerDto) {
    return this.identityService.registerBuyer(dto);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.identityService.login(dto);
    this.setSessionCookie(res, result.sessionToken, result.user.session_level);
    res.clearCookie(this.preauthCookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !this.isDevelopment(),
    });
    return {
      user: result.user,
      csrf_token: randomBytes(32).toString('hex'),
    };
  }

  @Get('me')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('normal')
  async getMe(@CurrentActor() actor: AuthenticatedActor) {
    return this.identityService.getMe(actor);
  }

  @Post('logout')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('normal', 'temp_password')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sessionToken = req.cookies?.[this.sessionCookieName];
    await this.identityService.logout(sessionToken);
    this.clearSessionCookie(res);
    return { logged_out: true };
  }

  @Post('change-password')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('normal')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.identityService.changePassword(actor, dto);
    this.clearSessionCookie(res);
    return { reauthentication_required: true };
  }

  @Post('change-temp-password')
  @Roles('buyer', 'artisan', 'admin')
  @SessionLevels('temp_password')
  @HttpCode(HttpStatus.OK)
  async changeTempPassword(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() dto: ChangeTempPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.identityService.changeTempPassword(actor, dto);
    this.clearSessionCookie(res);
    return { reauthentication_required: true };
  }
}
