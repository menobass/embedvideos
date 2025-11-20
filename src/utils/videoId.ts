import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet(alphabet, 8);

/**
 * Generates a random video ID (8 characters, alphanumeric lowercase)
 * Example: yn77aj9g
 */
export function generateVideoId(): string {
  return nanoid();
}
