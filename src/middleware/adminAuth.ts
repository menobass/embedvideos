import { Request, Response, NextFunction } from 'express';
import { Config } from '../config/config';

/**
 * Middleware to protect admin endpoints with password
 */
export function createAdminAuthMiddleware(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const password = req.headers['x-admin-password'] as string ||
                     req.headers['authorization']?.replace('Bearer ', '');
    
    console.log('Admin auth check - Password provided:', !!password, 'Expected:', config.adminPassword);
    
    if (!password) {
      return res.status(401).json({ 
        error: 'Admin password required',
        message: 'Please provide admin password in X-Admin-Password or Authorization header' 
      });
    }
    
    if (password !== config.adminPassword) {
      console.log('Password mismatch - Got:', password, 'Expected:', config.adminPassword);
      return res.status(403).json({ 
        error: 'Invalid admin password',
        message: 'The provided admin password is incorrect' 
      });
    }
    
    console.log('Admin auth successful');
    next();
  };
}
