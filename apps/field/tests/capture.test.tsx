// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './setup-i18n.js';
import { capturePhoto } from '../src/features/capture/capture.js';
import { PhotoCapture } from '../src/features/capture/PhotoCapture.js';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});
afterEach(cleanup);

const NOW = () => new Date('2026-11-01T08:30:00.000Z');
const photo = () => new File([new Uint8Array([0x61, 0x62, 0x63])], 'p.jpg', { type: 'image/jpeg' });

describe('capturePhoto', () => {
  it('records the SHA-256 (Web Crypto), device time and GPS', async () => {
    const res = await capturePhoto(photo(), { now: NOW, getPosition: async () => ({ lat: 12.97, lng: 77.59, accuracyM: 8 }) });
    expect(res).toEqual({
      ok: true,
      photo: expect.objectContaining({
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        sizeBytes: 3,
        mime: 'image/jpeg',
        capturedAt: '2026-11-01T08:30:00.000Z',
        gps: { lat: 12.97, lng: 77.59, accuracyM: 8 },
        gpsUnavailable: false,
      }),
    });
  });
  it('sets the gpsUnavailable flag when there is no position', async () => {
    const res = await capturePhoto(photo(), { now: NOW, getPosition: async () => null });
    expect(res.ok && res.photo.gps === null && res.photo.gpsUnavailable).toBe(true);
  });
  it('refuses other types and files over 10 MB', async () => {
    expect(await capturePhoto(new File(['x'], 'a.gif', { type: 'image/gif' }))).toEqual({ ok: false, problem: 'type' });
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'b.jpg', { type: 'image/jpeg' });
    expect(await capturePhoto(big)).toEqual({ ok: false, problem: 'size' });
  });
});

describe('<PhotoCapture>', () => {
  it('shows time, "location not available" and the fingerprint, then hands the photo over', async () => {
    const onCapture = vi.fn();
    render(<PhotoCapture onCapture={onCapture} now={NOW} getPosition={async () => null} />);
    fireEvent.change(screen.getByLabelText('Open camera'), { target: { files: [photo()] } });
    await waitFor(() => expect(screen.getByText('Location not available')).toBeTruthy());
    expect(screen.getByText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this photo' }));
    expect(onCapture).toHaveBeenCalledWith(expect.objectContaining({ gpsUnavailable: true, sizeBytes: 3 }));
  });
  it('explains a refused file', async () => {
    render(<PhotoCapture onCapture={() => {}} />);
    fireEvent.change(screen.getByLabelText('Open camera'), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('JPEG or PNG'));
  });
});
