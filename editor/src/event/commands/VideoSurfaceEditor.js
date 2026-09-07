// Legacy CommonJS path; the editor boots MediaSurfaceEditor.js directly.
(function(root) {
    if (typeof module !== 'undefined' && module.exports) module.exports = require('./MediaSurfaceEditor.js');
    else if (root.MediaSurfaceEditor) root.VideoSurfaceEditor = root.MediaSurfaceEditor;
})(globalThis);
