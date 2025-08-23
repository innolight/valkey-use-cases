export const delay = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

export const generateKey = (...parts: string[]): string => 
  parts.filter(Boolean).join(':');

export const parseExpiry = (expiry: string | number): number => {
  if (typeof expiry === 'number') return expiry;
  
  const value = parseInt(expiry.slice(0, -1));
  const unit = expiry.slice(-1).toLowerCase();
  
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return parseInt(expiry);
  }
};