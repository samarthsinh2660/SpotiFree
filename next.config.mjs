/** @type {import('next').NextConfig} */
export default {
  // Emits .next/standalone with only the files the server needs — small image,
  // and no npm install inside the runtime stage.
  output: 'standalone',
  // node:sqlite is a Node builtin; Next must not try to bundle it.
  serverExternalPackages: ['node:sqlite'],
};
