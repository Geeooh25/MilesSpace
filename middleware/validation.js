// middleware/validation.js
const { body, param, query, validationResult } = require('express-validator');

const validate = (validations) => {
    return async (req, res, next) => {
        await Promise.all(validations.map(validation => validation.run(req)));

        const errors = validationResult(req);
        if (errors.isEmpty()) {
            return next();
        }

        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: errors.array().map(e => ({ field: e.path, message: e.msg }))
        });
    };
};

// ─── VALIDATION RULES ───
const authValidation = {
    register: [
        body('email').isEmail().withMessage('Invalid email address'),
        body('password').isLength({ min: 10 }).withMessage('Password must be at least 10 characters')
            .matches(/[A-Z]/).withMessage('Password must contain uppercase letter')
            .matches(/[a-z]/).withMessage('Password must contain lowercase letter')
            .matches(/[0-9]/).withMessage('Password must contain number')
            .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain special character'),
        body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters')
            .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
        body('phone').optional().matches(/^0[789][01]\d{8}$/).withMessage('Invalid Nigerian phone number')
    ],
    login: [
        body('email').isEmail().withMessage('Invalid email address'),
        body('password').notEmpty().withMessage('Password required')
    ],
    pin: [
        body('pin').isLength({ min: 4, max: 4 }).withMessage('PIN must be exactly 4 digits')
            .matches(/^\d{4}$/).withMessage('PIN must contain only numbers')
    ],
    amount: [
        body('amount').isNumeric().withMessage('Amount must be a number')
            .custom(value => value > 0).withMessage('Amount must be greater than 0')
    ],
    crypto: [
        body('coin').isIn(['BTC', 'USDT', 'USDC']).withMessage('Invalid coin'),
        body('amount').isNumeric().withMessage('Amount must be a number')
            .custom(value => value > 0).withMessage('Amount must be greater than 0')
    ]
};

module.exports = { validate, authValidation };