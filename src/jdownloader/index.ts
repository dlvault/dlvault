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

/**
 * Outcome of {@link JDownloaderService.addLinks}:
 *  - `sent`    — links accepted by JD (online, or check inconclusive → let JD proceed)
 *  - `offline` — JD's online-check found EVERY link dead at the hoster; the package
 *                was pulled back out. The caller should blocklist the release and
 *                retry, so the same dead links aren't re-resolved next cycle.
 *  - `error`   — JD unreachable / add rejected. The caller should retry, NOT blocklist.
 */
export type AddLinksResult = 'sent' | 'offline' | 'error';

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
  /** The `jdownloader.device_name` the cached deviceId was resolved for. */
  private deviceIdForName: string | null = null;
  private loginSecret: Buffer | null = null;
  private deviceSecret: Buffer | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private lastConnectTime = 0;
  // Pre-download dead-link guard timing — how often to poll JD's online-check and
  // how long to wait for a verdict. Instance fields so tests can drive them to 0
  // (no real sleeps / no polling) instead of waiting out the real budget.
  private deadLinkPollMs = 2000;
  private deadLinkBudgetMs = 25_000;

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
    // A fresh login may be against different credentials entirely — the device
    // list belongs to the account, so a cached id from the previous one is void.
    this.invalidateDevice();

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

  /**
   * Lists the JDownloader instances attached to the account.
   *
   * Retries once on a fresh session, the way callDevice does. Without that this
   * was the one JD call that could not heal itself: on any failure it logged and
   * returned an empty list while leaving `sessionToken` in place, so the next
   * attempt reused the very same dead token. With SESSION_TTL matching the
   * five-minute JD monitor, that produced a steady ~12 failures an hour —
   * 388 of them over 33 hours on a live instance — while the download calls
   * beside it recovered fine through their 403 path.
   */
  async listDevices(retryCount = 0): Promise<JDDevice[]> {
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
      if (retryCount === 0) {
        this.sessionToken = null;
        this.lastConnectTime = 0;
        await this.connect(true);
        return this.listDevices(1);
      }
      // Reason goes in the message, not as a second argument: winston treats
      // that as metadata and this format drops it, so the log carried 388
      // identical lines ending in a colon with nothing after it.
      const status = error.response?.status;
      logger.error(`Failed to list JD devices${status ? ` (HTTP ${status})` : ''}: ${error.message || error}`);
      return [];
    }
  }

  private async getDeviceId(): Promise<string | null> {
    const deviceName = (getSetting('jdownloader.device_name') || '').trim();
    // Re-resolve when the configured name changed under us. The id was memoized
    // for the process lifetime with nothing ever clearing it, so pointing dlvault
    // at a different JD instance — or reinstalling JD, which mints a new device
    // id — kept every call addressed to the old, now-404ing id until the
    // container was restarted.
    if (this.deviceId && this.deviceIdForName === deviceName) return this.deviceId;

    const devices = await this.listDevices();

    if (devices.length === 0) {
      logger.error('No JDownloader devices found');
      return null;
    }

    let device: JDDevice | undefined;
    if (deviceName) {
      // Exact match first, then a trimmed/case-insensitive fallback. MyJDownloader
      // names an instance after its lowercase hostname (e.g. "JDownloader@windows"),
      // but users naturally type "@Windows" — and the old match was exact and
      // case-sensitive, so that single-character difference made getDeviceId return
      // null and EVERY download silently failed (no link reached JD, nothing to
      // move). The fallback recovers that very common case; exact matches are
      // unaffected.
      device = devices.find(d => d.name === deviceName)
        || devices.find(d => (d.name || '').trim().toLowerCase() === deviceName.toLowerCase());
      if (!device) {
        logger.error(
          `JDownloader device "${deviceName}" not found — available: ${devices.map(d => `"${d.name}"`).join(', ')}. ` +
          `Fix the device name in dlvault's JDownloader settings so it matches one of those.`,
        );
        return null;
      }
    } else {
      device = devices[0];
      if (devices.length > 1) {
        // Empty name + multiple devices = a coin flip over which JD gets the
        // downloads. Pick the first (legacy behaviour) but say so loudly.
        logger.warn(
          `No JDownloader device name configured but ${devices.length} devices exist — auto-selecting "${device.name}". ` +
          `If that's the wrong instance, set the exact name in settings. Available: ${devices.map(d => `"${d.name}"`).join(', ')}.`,
        );
      }
    }

    this.deviceId = device.id;
    this.deviceIdForName = deviceName;
    return this.deviceId;
  }

  /** Forget the resolved device so the next call re-discovers it. */
  private invalidateDevice(): void {
    this.deviceId = null;
    this.deviceIdForName = null;
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
        this.invalidateDevice();
        await this.connect(true);
        return this.callDevice(action, params, 1);
      }

      // 404 = the relay doesn't know this device id any more (JD reinstalled,
      // reconnected under a new id, or the account now hosts a different
      // instance). Non-transient, so the retry ladder below never covers it —
      // re-resolve once instead of failing every call until a restart.
      if (status === 404 && retryCount === 0) {
        logger.warn(`JD device id rejected (404) — re-resolving the device and retrying ${action}`);
        this.invalidateDevice();
        return this.callDevice(action, params, 1);
      }

      // Retry on transient errors (429, 5xx, network timeouts) with exponential backoff.
      // First-retry blips right after reconnect are common (session token refresh) and
      // almost always succeed on attempt 2 — log them at debug. Only escalate to warn
      // if we're already on attempt 2+ (i.e. a single retry wasn't enough).
      const isTransient = !status || status === 429 || status >= 500;
      if (isTransient && retryCount < 3) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 8000);
        const msg = `JD call ${action} failed (attempt ${retryCount + 1}/3), retrying in ${delay}ms...`;
        if (retryCount === 0) logger.debug(msg);
        else logger.warn(msg);
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

  async addLinks(links: string[], packageName: string): Promise<AddLinksResult> {
    try {
      // Check for duplicate package in downloads and linkgrabber. If either
      // query failed (JD unreachable) we can't run the dedup pass — fall back
      // to "just send, let JD handle it" rather than refusing the add.
      const [dlPackages, lgPackages] = await Promise.all([
        this.getDownloadPackages(),
        this.getLinkGrabberPackages(),
      ]);
      const allPackages = [...(dlPackages ?? []), ...(lgPackages ?? [])];
      // JD rewrites ':' → ';' in the package names it echoes back, so compare the
      // dedup candidates against the rewritten form — otherwise a colon title
      // ("Mission: Impossible (2024) - 1080p") never matches its own existing
      // package and gets re-sent as a duplicate on every retry/upgrade pass.
      const echoedName = packageName.replace(/:/g, ';');

      // Package names we generate look like "Title (Year)[ - Sxx] - <res>[ [TAG]]".
      // Dedup compares the title part, but the RESOLUTION is an identity field,
      // not noise: a quality upgrade is a genuinely different download. Folding
      // it into the prefix made "Movie (2024) - 2160p [UPGRADE]" match the
      // still-present "Movie (2024) - 1080p", so addLinks answered 'sent' without
      // adding anything while the caller flipped the movie to 'downloading' — the
      // upgrade never happened, on every single upgrade pass.
      const RES_SUFFIX_RE = /\s*-\s*(\d{3,4}p)$/i;
      const stripTag = (n: string) => n.replace(/\s*\[[^\]]*\]$/, '').trim();
      const baseOf = (n: string) => stripTag(n).replace(RES_SUFFIX_RE, '').trim();
      const resOf = (n: string): string | null => {
        const m = stripTag(n).match(RES_SUFFIX_RE);
        return m ? m[1].toLowerCase() : null;
      };

      const newBase = baseOf(echoedName);
      const newRes = resOf(echoedName);

      const isDuplicateOf = (name: string): boolean => {
        const exBase = baseOf(name);
        if (exBase !== newBase) {
          // Allow an existing name that EXTENDS ours with further tokens, but
          // require a token boundary — otherwise "Foo - S1" wrongly matches
          // "Foo - S10" and silently drops the S1 send.
          if (!exBase.startsWith(newBase)) return false;
          const rest = exBase.slice(newBase.length);
          if (!/^(\s+-\s|\s+\[)/.test(rest)) return false;
        }
        const exRes = resOf(name);
        // Both sides name a resolution and they differ → different edition.
        if (exRes && newRes && exRes !== newRes) return false;
        return true;
      };

      const existing = allPackages.find(p =>
        p.name === echoedName || (p.name ? isDuplicateOf(p.name) : false)
      );
      if (existing) {
        // Ignore dead/failed packages (0 bytes, no online links)
        const isDead = existing.bytesTotal === 0 && existing.childCount !== undefined && existing.childCount <= 1;
        if (isDead) {
          logger.info(`Package "${existing.name}" exists in JDownloader but is dead (0 bytes) — ignoring`);
        } else {
          logger.info(`Package "${packageName}" already in JDownloader (matched: "${existing.name}") — skipping duplicate`);
          return 'sent'; // Already present — treat as a successful send
        }
      }

      const result = await this.callDevice('/linkgrabberv2/addLinks', [{
        autostart: true,
        links: links.join('\n'),
        packageName,
        overwritePackagizerRules: true,
      }]);

      if (!result) return 'error';
      logger.info(`Added ${links.length} link(s) to JDownloader: ${packageName}`);

      // Proactive dead-link guard: a release whose links are ALL offline at the
      // hoster never starts (autostart finds nothing online) and would otherwise
      // sit in JD until the next status-sync notices it. Catch it here, pull the
      // dead package back out, and tell the caller to blocklist + retry — so the
      // same dead links aren't re-resolved on the next cycle.
      const allDead = await this.waitForAllOffline(packageName);
      return allDead ? 'offline' : 'sent';
    } catch (error: any) {
      logger.error('Failed to add links to JDownloader:', error.message);
      return 'error';
    }
  }

  /**
   * After links are added (autostart), poll the linkgrabber for this package and
   * decide whether it is DEFINITIVELY dead — i.e. JD's online-check finished and
   * EVERY link is offline (0 online, offline == childCount). Returns true and
   * removes the package in that case; false otherwise.
   *
   * Deliberately conservative and best-effort, because it gates a live download:
   *  - any online link (even in a mirror set) → false (let it download);
   *  - package already gone from the linkgrabber (online links auto-moved to the
   *    download list) → false;
   *  - JD hiccup / never settles within the budget → false (never block a real
   *    download on an inconclusive check — the reactive status-sync remains the
   *    safety net).
   */
  private async waitForAllOffline(packageName: string): Promise<boolean> {
    const echoed = packageName.replace(/:/g, ';');
    const matches = (n?: string): boolean => !!n && (n === packageName || n === echoed);
    const deadlineAt = Date.now() + this.deadLinkBudgetMs;
    let everSeen = false;
    let lastSig = '';
    let stable = 0;

    while (Date.now() < deadlineAt) {
      await new Promise((r) => setTimeout(r, this.deadLinkPollMs));
      const pkgs = await this.getLinkGrabberPackages();
      if (pkgs === null) return false; // JD unreachable — don't reject on no info

      const pkg = pkgs.find((p) => matches(p.name));
      if (!pkg) {
        // Gone after we'd seen it → online links moved to downloads (= not dead).
        // Not yet registered → keep waiting for the check to begin.
        if (everSeen) return false;
        continue;
      }
      everSeen = true;

      const online = pkg.onlineCount ?? 0;
      const offline = pkg.offlineCount ?? 0;
      const total = pkg.childCount ?? 0;
      if (online > 0) return false; // at least one good link → let it download

      // Treat the check as settled only when every child is accounted for as
      // offline AND the counts held steady across two consecutive polls (so a
      // mid-check snapshot that happens to show 0 online isn't mistaken for dead).
      const sig = `${online}/${offline}/${total}`;
      if (sig === lastSig && total > 0) stable++;
      else { stable = 0; lastSig = sig; }

      if (total > 0 && offline >= total && online === 0 && stable >= 1) {
        try {
          await this.removeLinkGrabberPackages([pkg.uuid]);
        } catch { /* best-effort cleanup */ }
        logger.warn(`Pre-download guard: "${packageName}" rejected — ${offline}/${total} links offline at hoster`);
        return true;
      }
    }
    return false; // inconclusive within budget → let JD/reactive-sync handle it
  }

  /**
   * Query JD's download list. Returns `null` (NOT `[]`) when the underlying
   * device call failed — callers that gate behaviour on "what JD currently
   * holds" (stale-reset, etc.) need to distinguish a successful empty response
   * from an outage to avoid acting on bad data.
   */
  async getDownloadPackages(): Promise<JDPackage[] | null> {
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
    if (result === null) return null;
    return (result.data as JDPackage[]) || [];
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

  /** Like {@link getDownloadPackages} — returns `null` on call failure. */
  async getLinkGrabberPackages(): Promise<JDPackage[] | null> {
    const result = await this.callDevice('/linkgrabberv2/queryPackages', [{
      bytesTotal: true,
      status: true,
      saveTo: true,
      comment: true,
      childCount: true,
      onlineCount: true,
      offlineCount: true,
    }]);
    if (result === null) return null;
    return (result.data as JDPackage[]) || [];
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

  /**
   * Current download-controller state as JD reports it (e.g. "RUNNING",
   * "STOPPED_STATE", "PAUSE", "IDLE"). Returns null if JD is unreachable so the
   * caller can distinguish "stopped" from "can't tell". Used by the JD monitor to
   * decide whether to auto-resume downloads after JD recovers from a restart.
   */
  async getCurrentState(): Promise<string | null> {
    const result = await this.callDevice('/downloadcontroller/getCurrentState', []);
    return typeof result?.data === 'string' ? result.data : null;
  }

  /**
   * Whether JDownloader has a self-update available. Reflects JD's own
   * (periodically refreshed) update-check cache — call runUpdateCheck() first to
   * force a fresh probe. Returns false when JD is unreachable.
   */
  async isUpdateAvailable(): Promise<boolean> {
    const result = await this.callDevice('/update/isUpdateAvailable', []);
    return result?.data === true;
  }

  /** Ask JD to refresh its update-check cache. Best-effort. */
  async runUpdateCheck(): Promise<boolean> {
    const result = await this.callDevice('/update/runUpdateCheck', []);
    return result !== null;
  }

  /**
   * Install the available update: JD restarts itself, applies it, and reconnects.
   * The device drops offline for a minute or two during this — the JD monitor's
   * offline alert + post-recovery auto-resume cover that window.
   */
  async restartAndUpdate(): Promise<boolean> {
    const result = await this.callDevice('/update/restartAndUpdate', []);
    return result !== null;
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

  /**
   * Make JD's pipeline fully non-interactive so no modal dialog can ever freeze
   * it. JD's RemoteAPIIOHandlerWrapper.show() BLOCKS the worker thread until a
   * dialog is answered — so the default extraction "file already exists" prompt
   * (IfFileExistsAction=ASK_FOR_EACH_FILE) hangs the extract→move thread and the
   * whole download pipeline stalls (downloads finish at 100% but never extract or
   * move). SKIP_FILE is the idempotent choice: JD only gives an extracted file its
   * final name on success, so a same-named file already on disk is complete — skip
   * it and let the post-processor move what's there. The /dialogs watchdog
   * (answerBlockingDialogs) is the catch-all backstop for any other dialog type.
   * Verified key/enum names against JD source (case-sensitive PascalCase).
   */
  async configureDownloadPolicies(): Promise<boolean> {
    try {
      const IFACE = 'org.jdownloader.extensions.extraction.ExtractionConfig';
      const result = await this.callDevice('/config/set', [IFACE, null, 'IfFileExistsAction', 'SKIP_FILE']);
      const ok = result !== null && 'data' in (result || {});
      if (ok) logger.info('JDownloader extraction policy set: IfFileExistsAction=SKIP_FILE (no interactive overwrite dialog)');
      else logger.warn('Failed to set JD extraction IfFileExistsAction policy (config/set returned no result)');
      return ok;
    } catch (error: any) {
      logger.error(`Failed to configure JD download policies: ${error.message}`);
      return false;
    }
  }

  /**
   * Pending RemoteAPI dialog ids. JDownloader routes EVERY modal dialog through the
   * /dialogs API — it enqueues to the API and shows the Swing window simultaneously
   * (dual delegation, no isRemoteAPIEnabled guard), so even a GUI-mode desktop JD's
   * dialogs are listable+answerable here. Returns [] when JD is unreachable.
   */
  async listDialogs(): Promise<number[]> {
    const result = await this.callDevice('/dialogs/list', []);
    const data = result?.data;
    return Array.isArray(data) ? data.map(Number).filter(n => Number.isFinite(n)) : [];
  }

  /** Inspect a pending dialog (type/title/properties) — used to log what we clear. */
  async getDialog(id: number): Promise<any | null> {
    const result = await this.callDevice('/dialogs/get', [id, false, true]);
    return result?.data ?? null;
  }

  /**
   * Answer a pending dialog. {closereason:"OK"} accepts it with its default field
   * values (CloseReason.OK = the affirmative/default button); "CANCEL"/"CLOSE"
   * dismiss it. Extra keys map to the dialog's getter names (stripped of get/is,
   * lowercased).
   */
  async answerDialog(id: number, data: Record<string, unknown> = { closereason: 'OK' }): Promise<boolean> {
    const result = await this.callDevice('/dialogs/answer', [id, data]);
    return result !== null;
  }

  /**
   * Catch-all watchdog: clear any pending JD modal dialog so it can never freeze
   * the pipeline again. Answers each with {closereason:"OK"} — JD pre-selects the
   * safe default (e.g. the duplicate-links dialog defaults to "don't add dupes").
   * Logs every dialog it clears (type+title) so per-type answers can be refined
   * from real production logs. Returns the answered dialogs for caller alerting.
   * Best-effort: a single failed answer never blocks the others.
   */
  async answerBlockingDialogs(): Promise<Array<{ id: number; type: string; title: string }>> {
    const ids = await this.listDialogs();
    if (ids.length === 0) return [];
    const answered: Array<{ id: number; type: string; title: string }> = [];
    for (const id of ids) {
      try {
        const info = await this.getDialog(id);
        const props = (info && typeof info === 'object' ? (info.properties ?? info) : {}) as Record<string, any>;
        const type = String(info?.type ?? props.type ?? 'unknown');
        const title = String(info?.title ?? props.title ?? props.message ?? '').slice(0, 200);
        // NEVER auto-answer a captcha challenge: it has its own pipeline (JD's
        // captcha subsystem + the 2Captcha solver), and blindly OK-ing it would
        // submit an empty/garbage answer and fail the link. Leave it for the
        // captcha path. (Captcha dialog class/type names contain "captcha".)
        if (/captcha/i.test(type) || /captcha/i.test(title)) {
          logger.debug(`JD dialog id=${id} looks like a captcha (type=${type}) — leaving for the captcha solver`);
          continue;
        }
        const ok = await this.answerDialog(id);
        if (ok) {
          answered.push({ id, type, title });
          logger.warn(`JD dialog auto-answered (OK) — id=${id} type=${type} title="${title}"`);
        } else {
          logger.error(`JD dialog answer failed — id=${id} type=${type} title="${title}"`);
        }
      } catch (err: any) {
        logger.error(`JD dialog handling failed for id=${id}: ${err.message}`);
      }
    }
    return answered;
  }

  async configure2CaptchaSolver(apiKey: string): Promise<boolean> {
    try {
      // Verified live: real interface is TwoCaptchaConfigInterface (not …Solver),
      // keys are PascalCase Enabled + ApiKey. The previous lowercase keys + wrong
      // interface silently no-op'd (JD's /config/set returns success against
      // non-existent interfaces too, so the failure was invisible).
      const IFACE = 'org.jdownloader.captcha.v2.solver.twocaptcha.TwoCaptchaConfigInterface';
      await this.callDevice('/config/set', [IFACE, null, 'Enabled', true]);
      await this.callDevice('/config/set', [IFACE, null, 'ApiKey', apiKey]);
      logger.info('JDownloader 2Captcha solver configured');
      return true;
    } catch (error: any) {
      logger.error(`Failed to configure JD 2Captcha: ${error.message}`);
      return false;
    }
  }

  // JD config keys are case-sensitive PascalCase. The previous all-lowercase
  // keys (e.g. "downloadspeedlimitenabled") silently no-op'd: set returned
  // success against a non-existent key, get returned a response with no .data
  // field. Verified key names + units via /config/list against a live JD 2.
  async getSpeedLimit(): Promise<number> {
    const result = await this.callDevice('/config/get', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'DownloadSpeedLimit',
    ]);
    const bps = typeof result?.data === 'number' ? result.data : 0;
    return Math.round(bps / 1024);
  }

  async setSpeedLimit(kbps: number): Promise<boolean> {
    const bps = Math.max(0, Math.round(kbps * 1024));
    const result = await this.callDevice('/config/set', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'DownloadSpeedLimit',
      bps,
    ]);
    // /config/set returns {data: null, rid} on success. callDevice yields null
    // only on connection/decrypt failure, so the presence of a result object
    // (i.e. `data` key exists, even if null) means the call reached JD.
    return result !== null && 'data' in (result || {});
  }

  async isSpeedLimited(): Promise<boolean> {
    const result = await this.callDevice('/config/get', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'DownloadSpeedLimitEnabled',
    ]);
    return result?.data === true;
  }

  async setSpeedLimitEnabled(enabled: boolean): Promise<boolean> {
    const result = await this.callDevice('/config/set', [
      'org.jdownloader.settings.GeneralSettings',
      null,
      'DownloadSpeedLimitEnabled',
      enabled,
    ]);
    return result !== null && 'data' in (result || {});
  }

  isConfigured(): boolean {
    return !!(getSetting('jdownloader.email') && getSetting('jdownloader.password'));
  }
}

export const jdownloaderService = new JDownloaderService();
