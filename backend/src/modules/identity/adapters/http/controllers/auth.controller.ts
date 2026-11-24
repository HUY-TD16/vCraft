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
import type { AuthenticatedActor } from '../../../../../common/application/types/contract-types';
import { APP_CONFIG, type AppConfig } from '../../../../../common/config/app-config';
import {
  clearSessionCookie,
  getPreauthCookieName,
  getSessionCookieName,
  isDevelopmentEnv,
  setSessionCookie,
} from '../../../../../common/http/helpers/cookie.helper';
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

  @Get('csrf')
  @Public()
  async getCsrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sessionToken = req.cookies?.[getSessionCookieName(this.config?.NODE_ENV)];
    if (typeof sessionToken === 'string' && sessionToken) {
      const actor = await this.identityService.resolveSession(sessionToken);
      if (actor) {
        return {
          csrf_token: randomBytes(32).toString('hex'),
          session_level: actor.sessionLevel,
        };
      }
    }

    const preauthName = getPreauthCookieName(this.config?.NODE_ENV);
    let preauthToken = req.cookies?.[preauthName];
    if (typeof preauthToken !== 'string' || !preauthToken) {
      preauthToken = randomBytes(32).toString('hex');
      res.cookie(preauthName, preauthToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: !isDevelopmentEnv(this.config?.NODE_ENV),
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
    setSessionCookie(res, result.sessionToken, result.user.session_level, this.config?.NODE_ENV);
    res.clearCookie(getPreauthCookieName(this.config?.NODE_ENV), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !isDevelopmentEnv(this.config?.NODE_ENV),
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
    const sessionToken = req.cookies?.[getSessionCookieName(this.config?.NODE_ENV)];
    await this.identityService.logout(sessionToken);
    clearSessionCookie(res, this.config?.NODE_ENV);
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
    clearSessionCookie(res, this.config?.NODE_ENV);
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
    clearSessionCookie(res, this.config?.NODE_ENV);
    return { reauthentication_required: true };
  }
}
