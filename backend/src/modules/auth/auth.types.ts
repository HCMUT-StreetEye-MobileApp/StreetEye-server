export interface AuthIdentity {
  authUserId: string;
  sessionId: string;
}

export interface Contributor {
  contributor_id: string;
  role: 'rider' | 'maintainer';
  disabled: boolean;
}

export type VerifyAccessToken = (token: string) => Promise<AuthIdentity>;
export type ResolveContributor = (identity: AuthIdentity) => Promise<Contributor | undefined>;
export interface AuthDependencies {
  verifyToken: VerifyAccessToken;
  resolveContributor: ResolveContributor;
}
