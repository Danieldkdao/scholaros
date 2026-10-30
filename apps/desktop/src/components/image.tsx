import type { DetailedHTMLProps, ImgHTMLAttributes } from 'react';
import { useTheme } from 'next-themes';

type ThemeImageSource = { light: string; dark?: string };

type ImageProps = Omit<
  DetailedHTMLProps<ImgHTMLAttributes<HTMLImageElement>, HTMLImageElement>,
  'src'
> & { src: ThemeImageSource };

// Vite resolves image imports to URL strings, and the renderer has no server
// pass, so next-themes already knows the resolved theme on the first render.
export const Image = ({ src, ...props }: ImageProps) => {
  const { resolvedTheme } = useTheme();
  return (
    <img
      {...props}
      src={resolvedTheme === 'dark' ? (src.dark ?? src.light) : src.light}
    />
  );
};
