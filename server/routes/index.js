import { registerAuthRoutes } from './auth.js';
import { registerUploadRoutes } from './upload.js';
import { registerImportRoutes } from './import.js';
import { registerGalleryRoutes } from './gallery.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAdminRoutes } from './admin.js';
import { registerServeRoutes } from './serve.js';
import { registerDuplicateRoutes } from './duplicates.js';

export function registerRoutes(app, upload) {
    registerAuthRoutes(app);
    registerUploadRoutes(app, upload);
    registerImportRoutes(app);
    registerGalleryRoutes(app);
    registerSettingsRoutes(app);
    registerAdminRoutes(app);
    registerServeRoutes(app);
    registerDuplicateRoutes(app);
}
