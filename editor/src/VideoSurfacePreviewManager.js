// Legacy CommonJS path; the editor boots MediaSurfacePreviewManager.js directly.
(function(root) {
    if (typeof module !== 'undefined' && module.exports) module.exports = require('./MediaSurfacePreviewManager.js');
    else if (root.MediaSurfacePreviewManager) root.VideoSurfacePreviewManager = root.MediaSurfacePreviewManager;
})(globalThis);
