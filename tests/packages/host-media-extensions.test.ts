import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as media from '../../source/shared/media/media-extensions.ts';
describe('media extensions', () => {
  it('reads the extension from the end of a name, from either separator', () => {
    assert.equal(media.extensionOf('a.png'), '.png');
    assert.equal(media.extensionOf('A.PNG'), '.png');
    assert.equal(media.extensionOf('/x/y/a.JPG'), '.jpg');
    assert.equal(media.extensionOf('C:\\dir\\a.MP4'), '.mp4');
    assert.equal(media.extensionOf("C:\\dir.name\\noext"), "");
    assert.equal(media.extensionOf("/x/y.dir/noext"), "");
    assert.equal(media.extensionOf('a.tar.gz'), '.gz');
    assert.equal(media.extensionOf('noext'), '');
    assert.equal(media.extensionOf('a/b/'), '');
    assert.equal(media.extensionOf(''), '');
    // A leading dot names a hidden file rather than an extension.
    assert.equal(media.extensionOf('.gitignore'), '');
    assert.equal(media.extensionOf('a/b/.hidden'), '');
    assert.deepEqual(Object.keys(media).sort(), ['AUDIO_MIME_FROM_EXTENSION', 'CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION', 'EXTENSION_FROM_IMAGE_MIME', 'IMAGE_MIME_FROM_EXTENSION', 'VIDEO_MIME_FROM_EXTENSION', 'extensionOf']);
  });
  it('carries the extension and media-type tables the platform knows', () => {
    assert.deepEqual(media.IMAGE_MIME_FROM_EXTENSION, { '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' });
    assert.deepEqual(media.CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION, { '.heic': 'image/heic', '.heif': 'image/heif' });
    assert.deepEqual(media.EXTENSION_FROM_IMAGE_MIME, { 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/gif': '.gif', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico' });
    assert.deepEqual(media.VIDEO_MIME_FROM_EXTENSION, { '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.ogv': 'video/ogg', '.webm': 'video/webm' });
    assert.deepEqual(media.AUDIO_MIME_FROM_EXTENSION, { '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.oga': 'audio/ogg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.weba': 'audio/webm' });
    assert.equal(Object.getPrototypeOf(media.IMAGE_MIME_FROM_EXTENSION), Object.prototype);
  });
});