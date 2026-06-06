import axios from 'axios';
import { getSetting } from '../database/index';
import { logger } from '../utils/logger';

const TWOCAPTCHA_API = 'https://2captcha.com';

type CaptchaType = 'click' | 'puzzle' | 'recaptcha';

interface CaptchaResult {
  solution: string;
  provider: string;
}

/**
 * Captcha-solving facade exposed to plugins that declare the `captcha`
 * permission. Currently backed by 2Captcha — the `type` argument is kept on
 * the public API so plugin authors can hint at the captcha shape, but all
 * paths go through the same 2Captcha endpoint.
 */
export class CaptchaService {
  async solveCaptcha(siteKey: string, pageUrl: string, _type: CaptchaType = 'recaptcha'): Promise<CaptchaResult | null> {
    return this.solveWith2Captcha(siteKey, pageUrl);
  }

  private async solveWith2Captcha(siteKey: string, pageUrl: string): Promise<CaptchaResult | null> {
    const apiKey = getSetting('secret-store.2captcha-api-key');
    if (!apiKey) return null;

    try {
      const createResponse = await axios.get(`${TWOCAPTCHA_API}/in.php`, {
        params: {
          key: apiKey,
          method: 'userrecaptcha',
          googlekey: siteKey,
          pageurl: pageUrl,
          json: 1,
        },
      });

      if (createResponse.data.status !== 1) {
        logger.error('2Captcha create error:', createResponse.data.request);
        return null;
      }

      const requestId = createResponse.data.request;
      return await this.poll2Captcha(apiKey, requestId);
    } catch (error: any) {
      logger.error('2Captcha error:', error.message);
      return null;
    }
  }

  private async poll2Captcha(apiKey: string, requestId: string): Promise<CaptchaResult | null> {
    const maxAttempts = 24; // 24 * 5s = 120s max
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(5000);

      const response = await axios.get(`${TWOCAPTCHA_API}/res.php`, {
        params: { key: apiKey, action: 'get', id: requestId, json: 1 },
        timeout: 10000,
      });

      if (response.data.status === 1) {
        return {
          solution: response.data.request,
          provider: '2captcha',
        };
      }

      if (response.data.request !== 'CAPCHA_NOT_READY') {
        logger.error('2Captcha poll error:', response.data.request);
        return null;
      }
    }

    logger.error('2Captcha timeout');
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isConfigured(): boolean {
    return !!getSetting('secret-store.2captcha-api-key');
  }

  getStatus(): { twocaptcha: boolean } {
    return {
      twocaptcha: !!getSetting('secret-store.2captcha-api-key'),
    };
  }
}

export const captchaService = new CaptchaService();
