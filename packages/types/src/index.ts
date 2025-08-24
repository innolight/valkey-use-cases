export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTime: number;
}

export interface LeaderboardEntry {
  id: string;
  score: number;
  rank: number;
  metadata?: Record<string, any>;
}

export interface SessionData {
  userId: string;
  createdAt: Date;
  lastActivity: Date;
  data: Record<string, any>;
}

export interface JobData {
  id: string;
  type: string;
  payload: any;
  priority?: number;
  delay?: number;
  attempts?: number;
}
