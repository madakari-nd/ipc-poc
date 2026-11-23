import tokens from '../tokens.json';

type Pairs = Record<string, { fg: string; bg: string; hover?: string }>;

function pairs(group: Pairs): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(group).map(([k, v]) => [k, { ...v, DEFAULT: v.bg }]),
  );
}

const fontSize = Object.fromEntries(
  Object.entries(tokens.font.size).map(([k, [size, lineHeight]]) => [k, [size, { lineHeight }]]),
);

/**
 * Tailwind preset generated from tokens.json (Constitution IX). The theme REPLACES Tailwind's
 * default colours, spacing, radius and shadows so no ad-hoc values are available.
 */
const preset = {
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      ...tokens.color.base,
      action: pairs(tokens.color.action),
      feedback: pairs(tokens.color.feedback),
      state: pairs(tokens.color.state),
      risk: pairs(tokens.color.risk),
      legend: pairs(tokens.color.legend),
    },
    spacing: { ...tokens.space, touch: tokens.size.touch },
    borderRadius: { ...tokens.radius, DEFAULT: tokens.radius.md },
    boxShadow: { ...tokens.elevation, DEFAULT: tokens.elevation['1'] },
    fontFamily: {
      sans: [tokens.font.family.sans],
      mono: [tokens.font.family.mono],
    },
    fontSize,
    fontWeight: {
      normal: tokens.font.weight.regular,
      medium: tokens.font.weight.medium,
      semibold: tokens.font.weight.semibold,
      bold: tokens.font.weight.bold,
    },
    extend: {
      minHeight: { touch: tokens.size.touch },
      minWidth: { touch: tokens.size.touch },
      outlineColor: { focus: tokens.color.base.focus },
      ringColor: { focus: tokens.color.base.focus },
    },
  },
};

export default preset;
