import { and, eq, lte } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { alerts, certificateAuthorities, certificates, sslCertificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AlertService } from '@/modules/audit/alert.service.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('ExpiryAlertJob');

export class ExpiryAlertJob {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly alertService: AlertService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  async run(): Promise<void> {
    logger.info('Starting expiry alert check');

    const { expiryWarningDays, expiryCriticalDays } = getEnvironmentSettingsSnapshot().pkiDefaults;
    const now = new Date();
    const warningThreshold = new Date(now);
    warningThreshold.setDate(warningThreshold.getDate() + expiryWarningDays);
    const criticalThreshold = new Date(now);
    criticalThreshold.setDate(criticalThreshold.getDate() + expiryCriticalDays);

    let alertsCreated = 0;

    // 1. Check SSL certificates
    const expiringSSL = await this.db.query.sslCertificates.findMany({
      where: and(eq(sslCertificates.status, 'active'), lte(sslCertificates.notAfter, warningThreshold)),
      columns: {
        id: true,
        name: true,
        notAfter: true,
        domainNames: true,
      },
    });

    for (const cert of expiringSSL) {
      if (!cert.notAfter) continue;

      const isCritical = cert.notAfter <= criticalThreshold;
      const alertType = isCritical ? ('expiry_critical' as const) : ('expiry_warning' as const);

      const exists = await this.alertExists(alertType, 'ssl_certificate', cert.id);
      if (exists) continue;

      const daysLeft = Math.ceil((cert.notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      await this.alertService.createAlert({
        type: alertType,
        resourceType: 'ssl_certificate',
        resourceId: cert.id,
        message: `SSL certificate "${cert.name}" (${cert.domainNames?.join(', ')}) expires in ${daysLeft} day(s) on ${cert.notAfter.toISOString()}.`,
      });
      alertsCreated++;
      logger.info(`Created ${alertType} alert for SSL certificate: ${cert.name}`, { certId: cert.id, daysLeft });
      if (daysLeft <= 0) {
        this.eventBus?.publish('ssl.cert.changed', { id: cert.id, action: 'expired', name: cert.name });
      }
    }

    // 2. Check PKI certificates
    const expiringPKI = await this.db.query.certificates.findMany({
      where: and(eq(certificates.status, 'active'), lte(certificates.notAfter, warningThreshold)),
      columns: {
        id: true,
        commonName: true,
        notAfter: true,
      },
    });

    for (const cert of expiringPKI) {
      const isCritical = cert.notAfter <= criticalThreshold;
      const alertType = isCritical ? ('expiry_critical' as const) : ('expiry_warning' as const);

      const exists = await this.alertExists(alertType, 'certificate', cert.id);
      if (exists) continue;

      const daysLeft = Math.ceil((cert.notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      await this.alertService.createAlert({
        type: alertType,
        resourceType: 'certificate',
        resourceId: cert.id,
        message: `PKI certificate "${cert.commonName}" expires in ${daysLeft} day(s) on ${cert.notAfter.toISOString()}.`,
      });
      alertsCreated++;
      logger.info(`Created ${alertType} alert for PKI certificate: ${cert.commonName}`, { certId: cert.id, daysLeft });
    }

    // 3. Check certificate authorities
    const expiringCAs = await this.db.query.certificateAuthorities.findMany({
      where: and(eq(certificateAuthorities.status, 'active'), lte(certificateAuthorities.notAfter, warningThreshold)),
      columns: {
        id: true,
        commonName: true,
        notAfter: true,
        type: true,
      },
    });

    for (const ca of expiringCAs) {
      const isCritical = ca.notAfter <= criticalThreshold;
      const alertType = isCritical ? ('expiry_critical' as const) : ('ca_expiry' as const);

      const exists = await this.alertExists(alertType, 'certificate_authority', ca.id);
      if (exists) continue;

      const daysLeft = Math.ceil((ca.notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      await this.alertService.createAlert({
        type: alertType,
        resourceType: 'certificate_authority',
        resourceId: ca.id,
        message: `${ca.type === 'root' ? 'Root' : 'Intermediate'} CA "${ca.commonName}" expires in ${daysLeft} day(s) on ${ca.notAfter.toISOString()}.`,
      });
      alertsCreated++;
      logger.info(`Created ${alertType} alert for CA: ${ca.commonName}`, { caId: ca.id, daysLeft });
    }

    logger.info('Expiry alert job completed', {
      alertsCreated,
      checked: {
        sslCertificates: expiringSSL.length,
        pkiCertificates: expiringPKI.length,
        certificateAuthorities: expiringCAs.length,
      },
    });
  }

  /**
   * Check if an undismissed alert of this type already exists for the resource,
   * to avoid creating duplicate alerts.
   */
  private async alertExists(alertType: string, resourceType: string, resourceId: string): Promise<boolean> {
    const existing = await this.db.query.alerts.findFirst({
      where: and(
        eq(alerts.type, alertType as any),
        eq(alerts.resourceType, resourceType),
        eq(alerts.resourceId, resourceId),
        eq(alerts.dismissed, false)
      ),
    });
    return !!existing;
  }
}
