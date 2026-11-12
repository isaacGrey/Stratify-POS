
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

await mkdir('./public/icons', { recursive: true });

const source = './public/stratify-logo.png';

for (const size of [192, 512]) {
    await sharp(source)
        .resize(size, size, {
            fit: 'contain',
            background: '#FFFFFF'
        })
        .png()
        .toFile(`./public/icons/icon-${size}.png`);
}

console.log('StratifyPOS PWA icons generated.');
