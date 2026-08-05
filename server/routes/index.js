import { registerAuthRoutes } from './auth.js';
import { registerUploadRoutes } from './upload.js';
import { registerImportRoutes } from './import.js';
import { registerGalleryRoutes } from './gallery.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAdminRoutes } from './admin.js';
import { registerServeRoutes } from './serve.js';

/**
 * Register all API and media-serving routes.
 * @param {import('express').Express} app
 * @param {import('multer').Multer} upload
 */
export function registerRoutes(app, upload) {
    registerAuthRoutes(app);
    registerUploadRoutes(app, upload);
    registerImportRoutes(app);
    registerGalleryRoutes(app);
    registerSettingsRoutes(app);
    registerAdminRoutes(app);
    registerServeRoutes(app);
}
