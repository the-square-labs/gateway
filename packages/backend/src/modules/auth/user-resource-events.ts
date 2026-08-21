export const USER_RESOURCE_EVENT_CHANNEL_PREFIXES = {
  apiToken: 'api.token.changed.',
  inferenceToken: 'inference.token.changed.',
  oauthAuthorization: 'oauth.authorization.changed.',
} as const;

export function apiTokenChangedChannel(userId: string): string {
  return `${USER_RESOURCE_EVENT_CHANNEL_PREFIXES.apiToken}${userId}`;
}

export function inferenceTokenChangedChannel(userId: string): string {
  return `${USER_RESOURCE_EVENT_CHANNEL_PREFIXES.inferenceToken}${userId}`;
}

export function oauthAuthorizationChangedChannel(userId: string): string {
  return `${USER_RESOURCE_EVENT_CHANNEL_PREFIXES.oauthAuthorization}${userId}`;
}

export function userResourceChannelUserId(channel: string): string | null {
  for (const prefix of Object.values(USER_RESOURCE_EVENT_CHANNEL_PREFIXES)) {
    if (channel.startsWith(prefix)) return channel.slice(prefix.length) || null;
  }
  return null;
}
