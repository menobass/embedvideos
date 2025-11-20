import { Request, Response, NextFunction } from 'express';
import { Database } from '../database/mongodb';

/**
 * Middleware to validate API key from request headers
 */
export function createApiKeyMiddleware(database: Database) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get API key from header (try both formats)
      const apiKey = req.headers['x-api-key'] as string || 
                     req.headers['authorization']?.replace('Bearer ', '');
      
      if (!apiKey) {
        return res.status(401).json({ 
          error: 'API key required',
          message: 'Please provide an API key in X-API-Key or Authorization header' 
        });
      }
      
      // Validate API key
      const keyData = await database.getApiKey(apiKey);
      
      if (!keyData) {
        return res.status(401).json({ 
          error: 'Invalid API key',
          message: 'The provided API key does not exist' 
        });
      }
      
      if (!keyData.active) {
        return res.status(403).json({ 
          error: 'API key revoked',
          message: 'This API key has been deactivated. Please contact support.' 
        });
      }
      
      // Update last used timestamp (fire and forget)
      database.updateApiKeyLastUsed(apiKey).catch(console.error);
      
      // Attach API key info to request for later use
      (req as any).apiKey = keyData;
      
      next();
    } catch (error) {
      console.error('API key validation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
