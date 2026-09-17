import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateTemplateInput, UpdateTemplateInput } from './templates.schemas.js';
export class TemplatesService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient) {}
  setEventBus(_bus: EventBusService): void {}
  async seedBuiltinTemplates(): Promise<void> {}
  async listTemplates(): Promise<
    {
      id: string;
      name: string;
      description: string | null;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      keyAlgorithm: 'ecdsa-p256' | 'rsa-2048' | 'rsa-4096' | 'ecdsa-p384';
      isBuiltin: boolean;
      certType: 'tls-server' | 'tls-client' | 'email' | 'code-signing';
      validityDays: number;
      keyUsage: string[];
      extKeyUsage: string[];
      requireSans: boolean;
      sanTypes: string[] | null;
      subjectDnFields: {
        o?: string;
        ou?: string;
        l?: string;
        st?: string;
        c?: string;
        serialNumber?: string;
      } | null;
      crlDistributionPoints: string[] | null;
      authorityInfoAccess: {
        ocspUrl?: string;
        caIssuersUrl?: string;
      } | null;
      certificatePolicies:
        | {
            oid: string;
            qualifier?: string;
          }[]
        | null;
      customExtensions:
        | {
            oid: string;
            critical: boolean;
            value: string;
          }[]
        | null;
    }[]
  > {
    return [];
  }
  async getTemplate(_id: string): Promise<
    | {
        id: string;
        name: string;
        description: string | null;
        createdAt: Date;
        updatedAt: Date;
        createdById: string | null;
        keyAlgorithm: 'ecdsa-p256' | 'rsa-2048' | 'rsa-4096' | 'ecdsa-p384';
        isBuiltin: boolean;
        certType: 'tls-server' | 'tls-client' | 'email' | 'code-signing';
        validityDays: number;
        keyUsage: string[];
        extKeyUsage: string[];
        requireSans: boolean;
        sanTypes: string[] | null;
        subjectDnFields: {
          o?: string;
          ou?: string;
          l?: string;
          st?: string;
          c?: string;
          serialNumber?: string;
        } | null;
        crlDistributionPoints: string[] | null;
        authorityInfoAccess: {
          ocspUrl?: string;
          caIssuersUrl?: string;
        } | null;
        certificatePolicies:
          | {
              oid: string;
              qualifier?: string;
            }[]
          | null;
        customExtensions:
          | {
              oid: string;
              critical: boolean;
              value: string;
            }[]
          | null;
      }
    | undefined
  > {
    return undefined;
  }
  async createTemplate(
    _input: CreateTemplateInput,
    _userId: string
  ): Promise<{
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    keyAlgorithm: 'ecdsa-p256' | 'rsa-2048' | 'rsa-4096' | 'ecdsa-p384';
    isBuiltin: boolean;
    certType: 'tls-server' | 'tls-client' | 'email' | 'code-signing';
    validityDays: number;
    keyUsage: string[];
    extKeyUsage: string[];
    requireSans: boolean;
    sanTypes: string[] | null;
    subjectDnFields: {
      o?: string;
      ou?: string;
      l?: string;
      st?: string;
      c?: string;
      serialNumber?: string;
    } | null;
    crlDistributionPoints: string[] | null;
    authorityInfoAccess: {
      ocspUrl?: string;
      caIssuersUrl?: string;
    } | null;
    certificatePolicies:
      | {
          oid: string;
          qualifier?: string;
        }[]
      | null;
    customExtensions:
      | {
          oid: string;
          critical: boolean;
          value: string;
        }[]
      | null;
  }> {
    return commercialModuleUnavailable();
  }
  async updateTemplate(
    _id: string,
    _input: UpdateTemplateInput
  ): Promise<{
    id: string;
    name: string;
    description: string | null;
    isBuiltin: boolean;
    certType: 'tls-server' | 'tls-client' | 'email' | 'code-signing';
    keyAlgorithm: 'ecdsa-p256' | 'rsa-2048' | 'rsa-4096' | 'ecdsa-p384';
    validityDays: number;
    keyUsage: string[];
    extKeyUsage: string[];
    requireSans: boolean;
    sanTypes: string[] | null;
    subjectDnFields: {
      o?: string;
      ou?: string;
      l?: string;
      st?: string;
      c?: string;
      serialNumber?: string;
    } | null;
    crlDistributionPoints: string[] | null;
    authorityInfoAccess: {
      ocspUrl?: string;
      caIssuersUrl?: string;
    } | null;
    certificatePolicies:
      | {
          oid: string;
          qualifier?: string;
        }[]
      | null;
    customExtensions:
      | {
          oid: string;
          critical: boolean;
          value: string;
        }[]
      | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteTemplate(_id: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
