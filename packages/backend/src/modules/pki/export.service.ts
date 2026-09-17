import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { CryptoService } from '@/services/crypto.service.js';
export class ExportService {
  declare readonly _cryptoService: CryptoService;
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_cryptoService: CryptoService) {}
  exportPEM(_certPem: string, _chainPems?: string[]): string {
    return commercialModuleUnavailable();
  }
  exportDER(_certPem: string): Buffer {
    return commercialModuleUnavailable();
  }
  exportChainPEM(_chainPems: string[]): string {
    return commercialModuleUnavailable();
  }
  exportPEMBundle(_input: { certificatePem: string; privateKeyPem: string; chainPems: string[] }): Buffer {
    return commercialModuleUnavailable();
  }
  async exportPKCS12(
    _certPem: string,
    _privateKeyPem: string,
    _passphrase: string,
    _chainPems?: string[]
  ): Promise<Buffer> {
    return commercialModuleUnavailable();
  }
  async exportJKS(
    _certPem: string,
    _privateKeyPem: string | null,
    _passphrase: string,
    _alias: string
  ): Promise<Buffer> {
    return commercialModuleUnavailable();
  }
  async exportCAKey(_privateKeyPem: string, _certPem: string, _passphrase: string): Promise<Buffer> {
    return commercialModuleUnavailable();
  }
}
