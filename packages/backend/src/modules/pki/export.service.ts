import { type StdioOptions, spawn } from 'node:child_process';
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
    return new Promise<Buffer>((resolve, reject) => {
      const passphraseFd = input.chainPem ? 6 : 5;
      const stdio: StdioOptions = [
        'ignore',
        'pipe',
        'pipe',
        ...Array.from({ length: passphraseFd - 2 }, (): 'pipe' => 'pipe'),
      ];
      const child = spawn(
        'openssl',
        [
          'pkcs12',
          '-export',
          '-inkey',
          '/dev/fd/3',
          '-in',
          '/dev/fd/4',
          ...(input.chainPem ? ['-certfile', '/dev/fd/5'] : []),
          '-out',
          '/dev/stdout',
          '-passout',
          `fd:${passphraseFd}`,
          '-name',
          'certificate',
        ],
        { stdio }
      );
      let stderr = '';
      const output: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', () => reject(new Error('PKCS#12 export is unavailable')));
      child.once('close', (code) => {
        if (code === 0) resolve(Buffer.concat(output));
        else reject(new Error(`PKCS#12 export failed${stderr ? ': OpenSSL rejected the certificate material' : ''}`));
      });
      const writeToFd = (fd: number, content: string) => {
        const stream = child.stdio[fd];
        if (!stream || !('end' in stream)) return false;
        stream.end(content);
        return true;
      };
      if (
        !writeToFd(3, input.privateKeyPem) ||
        !writeToFd(4, input.certPem) ||
        (input.chainPem && !writeToFd(5, input.chainPem)) ||
        !writeToFd(passphraseFd, input.passphrase)
      ) {
        child.kill();
        reject(new Error('PKCS#12 export is unavailable'));
      }
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
