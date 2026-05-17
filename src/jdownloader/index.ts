import axios from 'axios';
import crypto from 'crypto';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';

export interface JDDevice {
  id: string;
  name: string;
  type: string;
}

export interface JDPackage {
  uuid: number;
  name: string;
  bytesLoaded?: number;
  bytesTotal?: number;
  speed?: number;
  eta?: number;
  status?: string;
  finished?: boolean;
  running?: boolean;
  enabled?: boolean;
  saveTo?: string;
  comment?: string;
  childCount?: number;
  statusIconKey?: string;
  onlineCount?: number;
  offlineCount?: number;
}

export interface JDExtractionItem {
  archiveId?: string;
  controllerStatus?: string;
  progress?: number;
  eta?: number;
  archiveFiles?: string[];
  name?: string;
}

export interface JDLink {
  uuid: number;
  name?: string;
  bytesLoaded?: number;
  bytesTotal?: number;
  speed?: number;
  status?: string;
  finished?: boolean;
  running?: boolean;
  enabled?: boolean;
  url?: string;
  host?: string;
  availability?: string;
  packageUUID?: number;
}

const MY_JD_API = 'https://api.jdownloader.org';

export class JDownloaderService {
  private sessionToken: string | null = null;
  private regainToken: string | null = null;
  private serverEncryptionToken: Buffer | null = null;
  private deviceEncryptionToken: Buffer | null = null;
  private deviceId: string | null = null;
  private loginSecret: Buffer | null = null;
  private deviceSecret: Buffer | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private lastConnectTime = 0;

  private createSecret(email: string, password: string, domain: string): Buffer {
    return crypto.createHash('sha256')
      .update(Buffer.from(email.toLowerCase() + password + domain, 'utf-8'))
      .digest();
  }

  private encrypt(data: string, token: Buffer): string {
    const iv = token.subarray(0, 16);
    const key = token.subarray(16, 32);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
    return encrypted.toString('base64');
  }

  private decrypt(data: string, token: Buffer): string {
    const iv = token.subarray(0, 16);
    const key = token.subarray(16, 32);
    const ciphertext = Buffer.from(data, 'base64');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  private updateTokens(oldToken: Buffer, responseToken: string): Buffer {
    return crypto.createHash('sha256')
      .update(Buffer.concat([oldToken, Buffer.from(responseToken, 'hex')]))
      .digest();
  }

  private sign(data: string, key: Buffer): string {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
  }

  async connect(force = false): Promise<boolean> {
    // Reuse existing session if connected recently (within 5 minutes)
    const SESSION_TTL = 5 * 60 * 1000;
    if (!force && this.sessionToken && (Date.now() - this.lastConnectTime) < SESSION_TTL) {
      return true;
    }

    // Prevent concurrent connect calls — reuse in-flight promise
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<boolean> {
    const email = getSetting('jdownloader.email');
    const password = getSetting('jdownloader.password');

    if (!email || !password) {
      logger.warn('JDownloader not configured');
      return false;
    }

    this.loginSecret = this.createSecret(email, password, 'server');
    this.deviceSecret = this.createSecret(email, password, 'device');

    try {
      const query = `/my/connect?email=${encodeURIComponent(email)}&appkey=dlvault`;
      const signature = this.sign(query, this.loginSecret);
      const url = `${MY_JD_API}${query}&signature=${signature}`;

      const response = await axios.get(url, { responseType: 'text', timeout: 15000, transformResponse: [(data: string) => data] });
      const rawData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const decrypted = JSON.parse(this.decrypt(rawData, this.loginSecret));

      const sessiontoken: string = decrypted.sessiontoken;
      if (typeof sessiontoken !== 'string' || !sessiontoken) {
        logger.error('MyJDownloader connect failed: invalid sessiontoken in response');
        return false;
      }
      this.sessionToken = sessiontoken;
      this.regainToken = decrypted.regaintoken ?? null;
      this.serverEncryptionToken = this.updateTokens(this.loginSecret!, sessiontoken);
      this.deviceEncryptionToken = this.updateTokens(this.deviceSecret!, sessiontoken);
      this.lastConnectTime = Date.now();

      logger.info('Connected to MyJDownloader');
      return true;
    } catch (error: any) {
      const detail = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message || error.toString();
      logger.error(`MyJDownloader connect failed: ${detail}`);
      return false;
    }
  }

  async listDevices(): Promise<JDDevice[]> {
    if (!this.sessionToken) await this.connect();
    if (!this.sessionToken || !this.serverEncryptionToken) return [];

    try {
      const query = `/my/listdevices?sessiontoken=${this.sessionToken}`;
      const signature = this.sign(query, this.serverEncryptionToken);
      const url = `${MY_JD_API}${query}&signature=${signature}`;

      const response = await axios.get(url, { responseType: 'text', timeout: 15000, transformResponse: [(data: string) => data] });
      const decrypted = JSON.parse(this.decrypt(response.data, this.serverEncryptionToken));
      return decrypted.list || [];
    } catch (error: any) {
      logger.error('Failed to list JD devices:', error.message);
      return [];
    }
  }

  private async getDeviceId(): Promise<string | null> {
    if (this.deviceId) return this.deviceId;

    const deviceName = getSetting('jdownloader.device_name');
    const devices = await this.listDevices();

    if (devices.length === 0) {
      logger.error('No JDownloader devices found');
      return null;
    }

    const device = deviceName
      ? devices.find(d => d.name === deviceName)
      : devices[0];

    if (!device) {
      logger.error(`JDownloader device "${deviceName}" not found`);
      return null;
    }

    this.deviceId = device.id;
    return this.deviceId;
  }

  private async callDevice(action: string, params?: any[], retryCount = 0): Promise<any> {
    if (!this.sessionToken) await this.connect();
    const deviceId = await this.getDeviceId();
    if (!deviceId || !this.deviceEncryptionToken) return null;

    const rid = Math.floor(Math.random() * 1000000);
    // MyJDownloader API expects each param to be JSON-serialized individually
    const serializedParams = (params || []).map(p =>
      typeof p === 'object' ? JSON.stringify(p) : String(p)
    );
    const postData = JSON.stringify({
      apiVer: 1,
      url: action,
      params: serializedParams,
      rid,
    });

    const encrypted = this.encrypt(postData, this.deviceEncryptionToken);
    const path = `/t_${this.sessionToken}_${deviceId}${action}`;

    try {
      const response = await axios.post(
        `${MY_JD_API}${path}`,
        encrypted,
        { headers: { 'Content-Type': 'application/aesjson-jd' }, responseType: 'text', timeout: 15000, transformResponse: [(data: string) => data] }
      );
      return JSON.parse(this.decrypt(response.data, this.deviceEncryptionToken));
    } catch (error: any) {
      const status = error.response?.status;

      // Re-auth on 403
      if (status === 403 && retryCount === 0) {
        this.sessionToken = null;
        this.lastConnectTime = 0;
        await this.connect(true);
        return this.callDevice(action, params, 1);
      }

      // Retry on transient errors (429, 5xx, network timeouts) with exponential backoff
      const isTransient = !status || status === 429 || status >= 500;
      if (isTransient && retryCount < 3) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 8000);
        logger.warn(`JD call ${action} failed (attempt ${retryCount + 1}/3), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return this.callDevice(action, params, retryCount + 1);
      }

      // Try to decrypt error response
      let detail = error.message || error.toString();
      if (error.response?.data && this.deviceEncryptionToken) {
        try {
          detail = this.decrypt(error.response.data, this.deviceEncryptionToken);
        } catch {
          detail = `[${status}] ${error.response.data}`;
        }
      }
      logger.error(`JD device call failed (${action}): ${detail}`);
      return null;
    }
  }

  async addLinks(links: string[], packageName: string): Promise<boolean> {
    try {
      // Check for duplicate package in downloads and linkgrabber
      const [dlPackages, lgPackages] = await Promise.all([
        this.getDownloadPackages(),
        this.getLinkGrabberPackages(),
      ]);
      const allPackages = [...dlPackages, ...lgPackages];
      // Match exact name OR same title+year prefix (handles quality suffix differences)
      const namePrefix = packageName.replace(/\s*-\s*\d+p$/, '').trim();
      const existing = allPackages.find(p =>
        p.name === packageName || (p.name && p.name.startsWith(namePrefix))
      );
      if (existing) {
        // Ignore dead/failed packages (0 bytes, no online links)
        const isDead = existing.bytesTotal === 0 && existing.childCount !== undefined && existing.childCount <= 1;
        if (isDead) {
          logger.info(`Package "${existing.name}" exists in JDownloader but is dead (0 bytes) — ignoring`);
        } else {
          logger.info(`Package "${packageName}" already in JDownloader (matched: "${existing.name}") — skipping duplicate`);
          return true; // Return true so caller treats it as success
        }
      }

      const result = await this.callDevice('/linkgrabberv2/addLinks', [{
        autostart: true,
        links: links.join('\n'),
        packageName,
        overwritePackagizerRules: true,
      }]);

      if (result) {
        logger.info(`Added ${links.length} link(s) to JDownloader: ${packageName}`);
        return true;
      }
      return false;
    } catch (error: any) {
      logger.error('Failed to add links to JDownloader:', error.message);
      return false;
    }
  }

  async getDownloadPackages(): Promise<JDPackage[]> {
    const result = await this.callDevice('/downloadsV2/queryPackages', [{
      bytesLoaded: true,
      bytesTotal: true,
      speed: true,
      eta: true,
      status: true,
      finished: true,
      running: true,
      enabled: true,
      saveTo: true,
      comment: true,
      childCount: true,
      statusIconKey: true,
    }]);
    return result?.data || [];
  }

  async getDownloadLinks(packageIds?: number[]): Promise<JDLink[]> {
    const params: Record<string, unknown> = {
      bytesLoaded: true,
      bytesTotal: true,
      speed: true,
      status: true,
      finished: true,
      running: true,
      enabled: true,
      url: true,
      host: true,
    };
    if (packageIds) params.packageUUIDs = packageIds;
    const result = await this.callDevice('/downloadsV2/queryLinks', [params]);
    return result?.data || [];
  }

  async getLinkGrabberPackages(): Promise<JDPackage[]> {
    const result = await this.callDevice('/linkgrabberv2/queryPackages', [{
      bytesTotal: true,
      status: true,
      saveTo: true,
      comment: true,
      childCount: true,
      onlineCount: true,
      offlineCount: true,
    }]);
    return result?.data || [];
  }

  async getLinkGrabberLinks(packageIds?: number[]): Promise<JDLink[]> {
    const params: Record<string, unknown> = {
      bytesTotal: true,
      status: true,
      enabled: true,
      url: true,
      host: true,
      availability: true,
    };
    if (packageIds) params.packageUUIDs = packageIds;
    const result = await this.callDevice('/linkgrabberv2/queryLinks', [params]);
    return result?.data || [];
  }

  async startDownloads(): Promise<boolean> {
    const result = await this.callDevice('/downloadcontroller/start', []);
    return result !== null;
  }

  async stopDownloads(): Promise<boolean> {
    const result = await this.callDevice('/downloadcontroller/stop', []);
    return result !== null;
  }

  async pauseDownloads(pause: boolean): Promise<boolean> {
    const result = await this.callDevice('/downloadcontroller/pause', [pause]);
    return result !== null;
  }

  async getSpeed(): Promise<Record<string, unknown> | null> {
    const result = await this.callDevice('/downloadcontroller/getCurrentState', []);
    return result;
  }

  async removePackages(packageIds: number[]): Promise<boolean> {
    const result = await this.callDevice('/downloadsV2/removeLinks', [[], packageIds]);
    return result !== null;
  }

  async removeLinkGrabberPackages(packageIds: number[]): Promise<boolean> {
    const result = await this.callDevice('/linkgrabberv2/removeLinks', [[], packageIds]);
    return result !== null;
  }

  async moveLinkGrabberToDownloadlist(packageIds: number[]): Promise<boolean> {
    const result = await this.callDevice('/linkgrabberv2/moveToDownloadlist', [[], packageIds]);
    return result !== null;
  }

  async getExtractionQueue(): Promise<JDExtractionItem[]> {
    const result = await this.callDevice('/extraction/getQueue', []);
    const data = result?.data;
    return Array.isArray(data) ? data : [];
  }

  async configureExtractionOverwrite(): Promise<boolean> {
    try {
      await this.callDevice('/config/set', [
        'org.jdownloader.extensions.extraction.ExtractionExtension',
        null,
        'iffileexistaction',
        'OVERWRITE',
      ]);
      logger.info('JDownloader extraction set to overwrite existing files');
      return true;
    } catch (error: any) {
      logger.error(`Failed to configure JD extraction overwrite: ${error.message}`);
      return false;
    }
  }

  async configure2CaptchaSolver(apiKey: string): Promise<boolean> {
    try {
      // Enable 2Captcha solver in JDownloader
      await this.callDevice('/config/set', [
        'jd.captcha.easy.load.plugins.standard.twocaptcha.TwoCaptchaSolver',
        null,
        'enabled',
        true,
      ]);
      // Set API key
      await this.callDevice('/config/set', [
        'jd.captcha.easy.load.plugins.standard.twocaptcha.TwoCaptchaSolver',
        null,
        'apikey',
        apiKey,
      ]);
      logger.info('JDownloader 2Captcha solver configured');
      return true;
    } catch (error: any) {
      logger.error(`Failed to configure JD 2Captcha: ${error.message}`);
      return false;
    }
  }

  async getSpeedLimit(): Promise<number> {
    const result = await this.callDevice('/config/get', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'maxdownloadspeedinkilobytespersecond',
    ]);
    return result ?? 0;
  }

  async setSpeedLimit(kbps: number): Promise<boolean> {
    const result = await this.callDevice('/config/set', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'maxdownloadspeedinkilobytespersecond',
      kbps,
    ]);
    return result !== null;
  }

  async isSpeedLimited(): Promise<boolean> {
    const result = await this.callDevice('/config/get', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'downloadspeedlimitenabled',
    ]);
    return result === true;
  }

  async setSpeedLimitEnabled(enabled: boolean): Promise<boolean> {
    const result = await this.callDevice('/config/set', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'downloadspeedlimitenabled',
      enabled,
    ]);
    return result !== null;
  }

  isConfigured(): boolean {
    return !!(getSetting('jdownloader.email') && getSetting('jdownloader.password'));
  }
}

export const jdownloaderService = new JDownloaderService();
