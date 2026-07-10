import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import { constantTimeEqual, hmacBase64Url } from '../common/crypto';

interface Claims { transferId: string; reference: string; expires: number }

@Injectable()
export class TransferTokenService {
  private readonly secret = process.env.CHECKOUT_TOKEN_SECRET ?? process.env.WEBHOOK_MASTER_KEY ?? process.env.DEVICE_JOB_SIGNING_SECRET ?? 'development-only-secret-must-be-replaced';

  issue(claims: Claims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${hmacBase64Url(this.secret, `transfer:${payload}`)}`;
  }

  verify(token: string, reference: string): Claims {
    if (!token) throw new ApiException('forbidden', 'The transfer status token is required', HttpStatus.FORBIDDEN);
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !constantTimeEqual(signature, hmacBase64Url(this.secret, `transfer:${payload}`))) {
      throw new ApiException('forbidden', 'The transfer status token is invalid', HttpStatus.FORBIDDEN);
    }
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
      if (claims.reference !== reference || claims.expires < Math.floor(Date.now() / 1000)) throw new Error('expired');
      return claims;
    } catch {
      throw new ApiException('forbidden', 'The transfer status token is invalid or expired', HttpStatus.FORBIDDEN);
    }
  }
}
