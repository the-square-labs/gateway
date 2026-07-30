import { injectable } from 'tsyringe';
import type { CryptoService } from '@/services/crypto.service.js';

export interface SealedInferenceCredential {
  encryptedPayload: string;
  encryptedDek: string;
  keyVersion: number;
}

@injectable()
export class InferenceCredentialVault {
  constructor(private readonly cryptoService: CryptoService) {}

  seal(payload: object): SealedInferenceCredential {
    const serialized = JSON.stringify(payload);
    const encrypted = this.cryptoService.encryptString(serialized);
    return {
      encryptedPayload: encrypted.encryptedKey,
      encryptedDek: encrypted.encryptedDek,
      keyVersion: 1,
    };
  }

  open<T extends object>(credential: SealedInferenceCredential): T {
    const serialized = this.cryptoService.decryptString({
      encryptedKey: credential.encryptedPayload,
      encryptedDek: credential.encryptedDek,
    });
    return JSON.parse(serialized) as T;
  }
}
