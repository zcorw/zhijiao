import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type InjectionToken,
} from "@nestjs/common";
import { z } from "zod";
import { hash, verify, Algorithm } from "@node-rs/argon2";
export const loginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9@._+-]+$/);
export const displayNameSchema = z.string().trim().min(1).max(40);
export const passwordSchema = z.string().min(8).max(128);
export const credentialsSchema = z.strictObject({
  login: loginSchema,
  password: passwordSchema,
});
export const registrationSchema = credentialsSchema.extend({
  displayName: displayNameSchema,
});
export const argon2Passwords: PasswordHasher = {
  hash: (password) =>
    hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
  verify: async (encoded, password) => {
    try {
      return await verify(encoded, password);
    } catch {
      return false;
    }
  },
};
export interface Account {
  id: string;
  login: string;
  displayName: string;
  status: "active" | "disabled";
}
export interface StoredAccount extends Account {
  passwordHash: string;
}
export interface AccountRepository {
  create(account: StoredAccount): Promise<Account>;
  findByLogin(login: string): Promise<StoredAccount | undefined>;
  get(id: string): Promise<Account | undefined>;
  updateDisplayName(
    id: string,
    displayName: string,
  ): Promise<Account | undefined>;
  disable(id: string): Promise<void>;
}
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}
export interface AccountOptions {
  repository: AccountRepository;
  passwords: PasswordHasher;
  randomId: () => string;
}
export class AccountError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ACCOUNT"
      | "INVALID_CREDENTIALS"
      | "ALREADY_EXISTS"
      | "NOT_FOUND",
  ) {
    super(code);
  }
}
export const ACCOUNT_OPTIONS = Symbol("ACCOUNT_OPTIONS");
export class AccountService {
  private readonly dummy: Promise<string>;
  constructor(public readonly options: AccountOptions) {
    this.dummy = options.passwords.hash(options.randomId());
  }
  async createAccount(input: unknown): Promise<Account> {
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) throw new AccountError("INVALID_ACCOUNT");
    const { password, ...data } = parsed.data;
    return this.options.repository.create({
      ...data,
      id: this.options.randomId(),
      status: "active",
      passwordHash: await this.options.passwords.hash(password),
    });
  }
  async authenticateCredentials(input: unknown): Promise<Account> {
    const parsed = credentialsSchema.safeParse(input);
    if (!parsed.success) throw new AccountError("INVALID_CREDENTIALS");
    const stored = await this.options.repository.findByLogin(parsed.data.login);
    const valid = await this.options.passwords.verify(
      stored?.passwordHash ?? (await this.dummy),
      parsed.data.password,
    );
    if (!stored || !valid || stored.status !== "active")
      throw new AccountError("INVALID_CREDENTIALS");
    const { passwordHash: _secret, ...account } = stored;
    return account;
  }
  async getAccount(id: string): Promise<Account | undefined> {
    return this.options.repository.get(id);
  }
  async updateDisplayName(id: string, input: unknown): Promise<Account> {
    const value = z
      .strictObject({ displayName: displayNameSchema })
      .safeParse(input);
    if (!value.success) throw new AccountError("INVALID_ACCOUNT");
    const account = await this.options.repository.updateDisplayName(
      id,
      value.data.displayName,
    );
    if (!account) throw new AccountError("NOT_FOUND");
    return account;
  }
  async disableAccount(id: string): Promise<void> {
    await this.options.repository.disable(id);
  }
}
@Module({})
export class AccountModule {
  static registerAsync(options: {
    imports?: ModuleMetadata["imports"];
    inject?: InjectionToken[];
    useFactory: (
      ...dependencies: any[]
    ) => AccountOptions | Promise<AccountOptions>;
  }): DynamicModule {
    return {
      module: AccountModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: ACCOUNT_OPTIONS,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
        {
          provide: AccountService,
          inject: [ACCOUNT_OPTIONS],
          useFactory: (value: AccountOptions) => new AccountService(value),
        },
      ],
      exports: [AccountService],
    };
  }
}
