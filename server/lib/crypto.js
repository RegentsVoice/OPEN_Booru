import crypto from 'crypto';
import { Transform } from 'stream';

function deriveKeyFromPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

function encryptMasterKey(masterKey, password) {
    const salt = crypto.randomBytes(16);
    const key = deriveKeyFromPassword(password, salt);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decryptMasterKey(encryptedData, password) {
    const salt = encryptedData.subarray(0, 16);
    const iv = encryptedData.subarray(16, 32);
    const authTag = encryptedData.subarray(32, 48);
    const ciphertext = encryptedData.subarray(48);
    const key = deriveKeyFromPassword(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptDbBuffer(buffer, masterKey) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
}

function decryptDbBuffer(encryptedBuffer, masterKey) {
    const iv = encryptedBuffer.subarray(0, 16);
    const authTag = encryptedBuffer.subarray(16, 32);
    const ciphertext = encryptedBuffer.subarray(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function createDecryptStreamWithOffset(masterKey, iv, offset) {

    if (!Buffer.isBuffer(iv)) {
        iv = Buffer.from(iv || []);
    }
    if (iv.length !== 16) {
        throw new Error('Invalid IV length');
    }

    const blockIndex = Math.floor(offset / 16);
    const offsetInBlock = offset % 16;

    const ivBigInt = BigInt('0x' + iv.toString('hex'));
    const newIvBigInt = ivBigInt + BigInt(blockIndex);
    const newIv = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        newIv[15 - i] = Number((newIvBigInt >> BigInt(8 * i)) & BigInt(0xff));
    }

    const decipher = crypto.createDecipheriv('aes-256-ctr', masterKey, newIv);
    return { decipher, skipBytes: offsetInBlock };
}

function createSkipStream(skipBytes) {
    let skipped = 0;
    return new Transform({
        transform(chunk, encoding, callback) {
            if (skipped < skipBytes) {
                const remaining = skipBytes - skipped;
                if (chunk.length <= remaining) {
                    skipped += chunk.length;
                    callback();
                    return;
                }
                const sliceStart = remaining;
                skipped = skipBytes;
                const data = chunk.subarray(sliceStart);
                callback(null, data);
            } else {
                callback(null, chunk);
            }
        }
    });
}

export {
    deriveKeyFromPassword,
    encryptMasterKey,
    decryptMasterKey,
    encryptDbBuffer,
    decryptDbBuffer,
    createDecryptStreamWithOffset,
    createSkipStream
};
