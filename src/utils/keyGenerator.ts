import crypto from 'crypto';

/**
 * Generates a secure API key with format: sk_<appname>_<random>
 */
export function generateApiKey(appName: string): string {
  const randomPart = crypto.randomBytes(24).toString('hex'); // 48 characters
  const sanitizedAppName = appName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `sk_${sanitizedAppName}_${randomPart}`;
}

/**
 * Generates a simple admin token for basic auth
 */
export function generateAdminToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
