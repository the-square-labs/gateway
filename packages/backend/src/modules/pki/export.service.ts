import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CryptoService } from '@/services/crypto.service.js';

export class ExportService {
  constructor(readonly _cryptoService: CryptoService) {}

  exportPEM(certPem: string, chainPems?: string[]): string {
    const parts = [certPem.trim()];
    if (chainPems) {
      parts.push(...chainPems.map((p) => p.trim()));
    }
    return parts.join('\n');
  }

  exportDER(certPem: string): Buffer {
    const base64 = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');
    return Buffer.from(base64, 'base64');
  }

  exportChainPEM(chainPems: string[]): string {
    return chainPems.map((pem) => pem.trim()).join('\n');
  }

  exportPEMBundle(input: { certificatePem: string; privateKeyPem: string; chainPems: string[] }): Buffer {
    const fullchainPem = this.exportPEM(input.certificatePem, input.chainPems);
    const files = [
      { name: 'certificate.pem', content: Buffer.from(`${input.certificatePem.trim()}\n`) },
      { name: 'private-key.pem', content: Buffer.from(`${input.privateKeyPem.trim()}\n`) },
      ...(input.chainPems.length
        ? [{ name: 'chain.pem', content: Buffer.from(`${this.exportChainPEM(input.chainPems)}\n`) }]
        : []),
      { name: 'fullchain.pem', content: Buffer.from(`${fullchainPem}\n`) },
    ];

    return this.createStoredZip(files);
  }

  async exportPKCS12(
    certPem: string,
    privateKeyPem: string,
    passphrase: string,
    chainPems?: string[]
  ): Promise<Buffer> {
    return this.runOpenSSL({
      certPem,
      privateKeyPem,
      passphrase,
      chainPem: chainPems?.length ? this.exportChainPEM(chainPems) : undefined,
    });
  }

  async exportJKS(certPem: string, privateKeyPem: string | null, passphrase: string, _alias: string): Promise<Buffer> {
    // Note: JKS is a Java-specific format. For a proper implementation,
    // we'd need a dedicated JKS library. For now, we export as PKCS#12
    // which Java can import with: keytool -importkeystore -srckeystore file.p12 -srcstoretype PKCS12
    if (privateKeyPem) {
      return this.exportPKCS12(certPem, privateKeyPem, passphrase);
    }

    // For cert-only export (no private key), just return DER
    return this.exportDER(certPem);
  }

  async exportCAKey(privateKeyPem: string, certPem: string, passphrase: string): Promise<Buffer> {
    return this.exportPKCS12(certPem, privateKeyPem, passphrase);
  }

  private async runOpenSSL(input: {
    certPem: string;
    privateKeyPem: string;
    passphrase: string;
    chainPem?: string;
  }): Promise<Buffer> {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'gateway-pki-export-'));
    const privateKeyPath = join(tempDirectory, 'private-key');
    const certificatePath = join(tempDirectory, 'certificate');
    const chainPath = join(tempDirectory, 'chain');
    const archivePath = join(tempDirectory, 'archive');

    try {
      await chmod(tempDirectory, 0o700);
      await Promise.all([
        this.createFifo(privateKeyPath),
        this.createFifo(certificatePath),
        ...(input.chainPem ? [this.createFifo(chainPath)] : []),
        this.createFifo(archivePath),
      ]);

      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(
          'openssl',
          [
            'pkcs12',
            '-export',
            '-inkey',
            privateKeyPath,
            '-in',
            certificatePath,
            ...(input.chainPem ? ['-certfile', chainPath] : []),
            '-out',
            archivePath,
            '-passout',
            'fd:3',
            '-name',
            'certificate',
          ],
          { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }
        );
        let stderr = '';
        const output: Buffer[] = [];
        let childExited = false;
        let outputEnded = false;
        let exitCode: number | null = null;
        const complete = () => {
          if (!childExited || !outputEnded) return;
          if (exitCode === 0) resolve(Buffer.concat(output));
          else reject(new Error(`PKCS#12 export failed${stderr ? ': OpenSSL rejected the certificate material' : ''}`));
        };
        const outputStream = createReadStream(archivePath);
        outputStream.on('data', (chunk) => {
          output.push(Buffer.from(chunk));
        });
        outputStream.once('end', () => {
          outputEnded = true;
          complete();
        });
        outputStream.once('error', () => {
          child.kill();
          reject(new Error('PKCS#12 export is unavailable'));
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once('error', () => reject(new Error('PKCS#12 export is unavailable')));
        child.once('close', (code) => {
          childExited = true;
          exitCode = code;
          if (code === 0) complete();
          else {
            outputStream.destroy();
            reject(new Error(`PKCS#12 export failed${stderr ? ': OpenSSL rejected the certificate material' : ''}`));
          }
        });
        const passphraseStream = child.stdio[3];
        if (!passphraseStream || !('end' in passphraseStream)) {
          child.kill();
          reject(new Error('PKCS#12 export is unavailable'));
          return;
        }
        passphraseStream.end(input.passphrase);
        void Promise.all([
          this.writeFifo(privateKeyPath, input.privateKeyPem),
          this.writeFifo(certificatePath, input.certPem),
          ...(input.chainPem ? [this.writeFifo(chainPath, input.chainPem)] : []),
        ]).catch(() => {
          child.kill();
          reject(new Error('PKCS#12 export is unavailable'));
        });
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async createFifo(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('mkfifo', ['-m', '600', path]);
      child.once('error', () => reject(new Error('PKCS#12 export is unavailable')));
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('PKCS#12 export is unavailable'))));
    });
  }

  private async writeFifo(path: string, content: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(path, { mode: 0o600 });
      stream.once('error', reject);
      stream.once('finish', resolve);
      stream.end(content);
    });
  }

  private createStoredZip(files: Array<{ name: string; content: Buffer }>): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
      const name = Buffer.from(file.name, 'utf-8');
      const crc = this.crc32(file.content);
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0, 6);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(file.content.length, 18);
      localHeader.writeUInt32LE(file.content.length, 22);
      localHeader.writeUInt16LE(name.length, 26);
      localHeader.writeUInt16LE(0, 28);
      localParts.push(localHeader, name, file.content);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0, 8);
      centralHeader.writeUInt16LE(0, 10);
      centralHeader.writeUInt16LE(0, 12);
      centralHeader.writeUInt16LE(0, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(file.content.length, 20);
      centralHeader.writeUInt32LE(file.content.length, 24);
      centralHeader.writeUInt16LE(name.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(offset, 42);
      centralParts.push(centralHeader, name);
      offset += localHeader.length + name.length + file.content.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, centralDirectory, end]);
  }

  private crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
}
