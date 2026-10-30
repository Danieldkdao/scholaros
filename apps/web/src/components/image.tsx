'use client';

import { useEffect, useState } from 'react';
import NextImage, { type ImageProps, type StaticImageData } from 'next/image';
import { useTheme } from 'next-themes';

type ThemeImageSource = { light: StaticImageData; dark?: StaticImageData };

type ThemeImageProps = Omit<ImageProps, 'src'> & { src: ThemeImageSource };

export const Image = ({ src, ...props }: ThemeImageProps) => {
  const { resolvedTheme } = useTheme();
  // The server pass has no stored theme, so wait for the client theme before
  // swapping; choosing dark during hydration would not match the streamed HTML.
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const dark = mounted && resolvedTheme === 'dark';
  return (
    <NextImage {...props} src={dark ? (src.dark ?? src.light) : src.light} />
  );
};
