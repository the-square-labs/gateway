export const apiTokenChangedChannel = (userId: string) => `api.token.changed.${userId}`;
export const inferenceTokenChangedChannel = (userId: string) => `inference.token.changed.${userId}`;
export const oauthAuthorizationChangedChannel = (userId: string) =>
  `oauth.authorization.changed.${userId}`;
