import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { formatUserInitials } from '@scholaros/lib/formatters';

export const UserProfile = ({
  name,
  image,
  className,
  textClassName,
}: {
  name: string;
  image?: string | undefined | null;
  className?: string;
  textClassName?: string;
}) => {
  return (
    <Avatar className={className}>
      <AvatarImage src={image ?? undefined} />
      <AvatarFallback className={textClassName}>
        {formatUserInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
};
