export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}
