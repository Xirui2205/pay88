import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import { constantTimeEqual, hmacBase64Url } from '../common/crypto';

interface CheckoutClaims {
  depositId: string;
  txRef: string;
  expires: number;
}

@Injectable()
export class CheckoutTokenService {
  private readonly secret = process.env.CHECKOUT_TOKEN_SECRET ?? process.env.WEBHOOK_MASTER_KEY ?? process.env.DEVICE_JOB_SIGNING_SECRET ?? 'development-only-secret-must-be-replaced';

  issue(claims: CheckoutClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${hmacBase64Url(this.secret, payload)}`;
  }

  verify(token: string, txRef: string): CheckoutClaims {
    if (!token) throw new ApiException('forbidden', 'The checkout token is required', HttpStatus.FORBIDDEN);
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !constantTimeEqual(signature, hmacBase64Url(this.secret, payload))) {
      throw new ApiException('forbidden', 'The checkout token is invalid', HttpStatus.FORBIDDEN);
    }
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CheckoutClaims;
      if (claims.txRef !== txRef || claims.expires < Math.floor(Date.now() / 1000)) {
        throw new Error('expired');
      }
      return claims;
    } catch {
      throw new ApiException('forbidden', 'The checkout token is invalid or expired', HttpStatus.FORBIDDEN);
    }
  }
}
