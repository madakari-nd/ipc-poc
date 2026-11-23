import preset from '../../packages/design-system/src/tailwind-preset';

export default {
  presets: [preset],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/design-system/src/**/*.{ts,tsx}'],
};
