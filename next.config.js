/**
 * Next config.
 *
 * Два режима, различаются автоматически по NODE_ENV (его ставит сам Next:
 * `next build` -> production, `next dev` -> development), поэтому ни env-файлов,
 * ни cross-env не нужно:
 *
 * - production: статический экспорт в out/, который rust-embed вшивает в бинарник;
 * - development: экспорт выключен (он несовместим с dev-сервером), а /api/*
 *   проксируется в уже запущенный бэкенд, чтобы править UI на живых данных
 *   центрального Dolt без пересборки бинарника.
 */
const isProduction = process.env.NODE_ENV === 'production';

/** Порт локального бэкенда для dev-прокси (pm2-инстанс слушает 3056). */
const API_PORT = process.env.BEADS_API_PORT || '3056';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isProduction ? { output: 'export' } : {}),
  images: {
    unoptimized: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  ...(isProduction
    ? {}
    : {
        async rewrites() {
          return [
            { source: '/api/:path*', destination: `http://localhost:${API_PORT}/api/:path*` },
          ];
        },
      }),
};

module.exports = nextConfig;
