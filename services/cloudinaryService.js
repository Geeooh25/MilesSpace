// services/cloudinaryService.js - Complete Cloudinary Integration
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const crypto = require('crypto');

// ─── CONFIG ───
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log('✅ Cloudinary configured');

// ─── UPLOAD FILE ──────────────────────────────────────────────────────

async function uploadSupportFile(fileBuffer, options = {}) {
    return new Promise((resolve, reject) => {
        const {
            ticketId = 'general',
            messageId = null,
            folder = 'milesspace/support',
            resource_type = 'auto',
            use_filename = true,
            unique_filename = true,
        } = options;

        const publicId = messageId 
            ? `${folder}/tickets/${ticketId}/messages/${messageId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
            : `${folder}/tickets/${ticketId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: resource_type,
                public_id: publicId,
                use_filename: use_filename,
                unique_filename: unique_filename,
                folder: folder,
                timeout: 60000,
            },
            (error, result) => {
                if (error) {
                    console.error('❌ Cloudinary upload error:', error);
                    reject(error);
                } else {
                    resolve({
                        public_id: result.public_id,
                        secure_url: result.secure_url,
                        format: result.format,
                        bytes: result.bytes,
                        width: result.width || null,
                        height: result.height || null,
                        duration: result.duration || null,
                        resource_type: result.resource_type,
                        created_at: result.created_at,
                    });
                }
            }
        );

        // Create readable stream from buffer
        const readableStream = new Readable();
        readableStream.push(fileBuffer);
        readableStream.push(null);
        readableStream.pipe(uploadStream);
    });
}

// ─── DELETE FILE ──────────────────────────────────────────────────────

async function deleteSupportFile(publicId) {
    try {
        if (!publicId) return { success: true, message: 'No public ID provided' };
        
        const result = await cloudinary.uploader.destroy(publicId, {
            invalidate: true,
        });
        
        if (result.result === 'ok') {
            console.log(`🗑️ Deleted from Cloudinary: ${publicId}`);
            return { success: true, publicId };
        } else {
            console.warn(`⚠️ Cloudinary delete returned: ${result.result}`);
            return { success: false, result };
        }
    } catch (error) {
        console.error('❌ Cloudinary delete error:', error);
        return { success: false, error: error.message };
    }
}

// ─── DELETE MULTIPLE FILES ──────────────────────────────────────────

async function deleteMultipleFiles(publicIds) {
    if (!publicIds || publicIds.length === 0) return { success: true };
    
    const results = await Promise.all(
        publicIds.map(pid => deleteSupportFile(pid))
    );
    
    const failed = results.filter(r => !r.success);
    return {
        success: failed.length === 0,
        total: results.length,
        failed: failed.length,
        details: results,
    };
}

// ─── GET OPTIMIZED URL ──────────────────────────────────────────────

function getOptimizedImageUrl(publicId, options = {}) {
    const {
        width = 800,
        height = null,
        quality = 'auto',
        format = 'auto',
        crop = 'limit',
    } = options;

    let url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/`;
    
    const transformations = [];
    if (width) transformations.push(`w_${width}`);
    if (height) transformations.push(`h_${height}`);
    if (crop) transformations.push(`c_${crop}`);
    if (quality) transformations.push(`q_${quality}`);
    if (format) transformations.push(`f_${format}`);
    
    if (transformations.length > 0) {
        url += transformations.join(',') + '/';
    }
    
    url += publicId;
    return url;
}

// ─── GET THUMBNAIL URL ──────────────────────────────────────────────

function getThumbnailUrl(publicId, size = 150) {
    return getOptimizedImageUrl(publicId, {
        width: size,
        height: size,
        crop: 'thumb',
        quality: 'auto',
        format: 'auto',
    });
}

// ─── CHECK FILE TYPE ────────────────────────────────────────────────

function isImage(mimeType) {
    return mimeType && mimeType.startsWith('image/');
}

function isPDF(mimeType) {
    return mimeType === 'application/pdf';
}

function isText(mimeType) {
    return mimeType === 'text/plain' || mimeType === 'text/csv';
}

function isVideo(mimeType) {
    return mimeType && mimeType.startsWith('video/');
}

function isAudio(mimeType) {
    return mimeType && mimeType.startsWith('audio/');
}

function getResourceType(mimeType) {
    if (isImage(mimeType)) return 'image';
    if (isVideo(mimeType)) return 'video';
    if (isAudio(mimeType)) return 'raw';
    return 'raw';
}

// ─── EXPORT ──────────────────────────────────────────────────────────

module.exports = {
    uploadSupportFile,
    deleteSupportFile,
    deleteMultipleFiles,
    getOptimizedImageUrl,
    getThumbnailUrl,
    isImage,
    isPDF,
    isText,
    isVideo,
    isAudio,
    getResourceType,
};