import { MIMEType } from 'node:util';
import type { Request } from 'express';

export function isUploadRequest(req: Request): boolean {
  return req.method === 'POST' && /^\/api\/v1\/media\/upload\/?$/i.test(req.baseUrl + req.path);
}

export function hasMultipartBoundary(req: Request): boolean {
  if (!req.is('multipart/form-data')) return false;
  try {
    const boundary = new MIMEType(req.get('Content-Type')!).params.get('boundary');
    return boundary !== null && /^[0-9A-Za-z'()+_,./:=? -]{1,70}$/.test(boundary) && !boundary.endsWith(' ');
  } catch {
    return false;
  }
}
