// middleware/roleAuth.js - Role-Based Access Control
const { supabase, supabaseAdmin } = require('../db/supabase');

/**
 * Check if user has required role
 * @param {string} requiredRole - 'user', 'admin', or 'super_admin'
 */
const requireRole = (requiredRole) => {
  return async (req, res, next) => {
    try {
      // First, verify the user is authenticated
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
          success: false, 
          error: 'No token provided' 
        });
      }

      const token = authHeader.split(' ')[1];
      const { data: { user }, error } = await supabase.auth.getUser(token);
      
      if (error || !user) {
        return res.status(401).json({ 
          success: false, 
          error: 'Invalid or expired token' 
        });
      }

      // Get user profile
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('role, status')
        .eq('id', user.id)
        .single();

      if (profileError || !profile) {
        return res.status(404).json({ 
          success: false, 
          error: 'User profile not found' 
        });
      }

      if (profile.status === 'suspended') {
        return res.status(403).json({ 
          success: false, 
          error: 'Account suspended' 
        });
      }

      // Check role
      const userRole = profile.role || 'user';
      const roleHierarchy = {
        'user': 0,
        'admin': 1,
        'super_admin': 2
      };

      const requiredLevel = roleHierarchy[requiredRole] || 0;
      const userLevel = roleHierarchy[userRole] || 0;

      if (userLevel < requiredLevel) {
        return res.status(403).json({ 
          success: false, 
          error: `Requires ${requiredRole} privileges` 
        });
      }

      // Attach user to request
      req.user = { ...user, ...profile, id: user.id };
      req.token = token;
      
      next();
    } catch (error) {
      console.error('Role auth error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Authentication error' 
      });
    }
  };
};

// Shortcut: Check if user is admin
const isAdmin = requireRole('admin');

// Shortcut: Check if user is super admin
const isSuperAdmin = requireRole('super_admin');

module.exports = { requireRole, isAdmin, isSuperAdmin };