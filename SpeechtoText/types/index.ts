// Customer types
export interface CustomerInsights {
  insight_group_id: string;
  insight_time: string;
  insights: {
    current_focus: string;
    announcements_launches: string;
    engagement_insights: string;
    company_snapshot: string;
  };
  metadata?: {
    total_activities?: number;
    date_range_days?: number;
    activity_breakdown?: {
      linkedin?: number;
      x?: number;
      news?: number;
      blog?: number;
    };
  };
  age_hours: number;
}

export interface Customer {
  id: string;
  name: string;
  website: string;
  linkedin_url?: string;
  x_handle?: string;
  notes?: string;
  created_at: string;
  last_activity_at?: string;
  AWS_Team?: string;
  description?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  employee_count?: number;
  logo_url?: string;
  industry?: string;
  company_size?: string;
  founded_year?: number;
  // LinkedIn enrichment fields
  followers?: number;
  cover_image?: string;
  slogan?: string;
  competitors?: Array<{
    name: string;
    link: string;
    image: string;
  }>;
  specialties?: string[];
  funding?: {
    number_of_rounds?: number;
    last_round?: {
      type: string;
      date: string;
      amount: string;
    };
    investors?: Array<{
      name: string;
      crunchbase_url: string;
      image: string;
    }>;
  };
  key_people?: Array<{
    name: string;
    title: string;
    linkedin_url?: string;
    x_handle?: string;
    image?: string;
    linkedin_location?: string;
    linkedin_followers?: number;
    linkedin_about?: string;
    linkedin_current_company?: string;
    x_image?: string;
    x_name?: string;
    x_bio?: string;
    x_followers?: number;
    x_location?: string;
    x_blue_verified?: boolean;
  }>;
  // AI-generated insights (optional)
  latest_insights?: CustomerInsights | null;
}

// Activity types
export type ActivitySource = 'x' | 'linkedin' | 'news' | 'blog';

export interface ActivityMetadata {
  author_handle?: string;
  retweet_count?: number;
  like_count?: number;
  view_count?: number;
  comment_count?: number;
  media_type?: string;  // 'photo', 'video', 'card', 'document', 'image'
  media_url?: string;   // URL to media (image or video)
  thumbnail_url?: string; // Thumbnail URL for videos
  author_name?: string;
  author_title?: string;
  author_image?: string;
  is_company_post?: boolean;
  publisher?: string;
  category?: string;
  relevance_score?: number;
  heuristic_score?: number;
  llm_score?: number;
  hashtags?: string[];  // Extracted hashtags (without # symbol)
  // Activity classification metadata (structured details)
  category_metadata?: Record<string, any>;
  category_confidence?: number;
}

export interface Activity {
  id: string;
  customer_id: string;
  customer_name: string;
  source: ActivitySource;
  timestamp: string;
  title: string;
  snippet: string;
  url: string;
  metadata?: ActivityMetadata;
  AWS_Team?: string;
  marked_as_non_relevant?: boolean;
  activity_category?: string;  // Top-level for GSI: event_conference, funding, etc.
}

// Analytics types
export interface HeatmapEntry {
  customer_id: string;
  customer_name: string;
  x_count: number;
  linkedin_count: number;
  news_count: number;
  blog_count?: number;
  total_count: number;
  [key: string]: string | number | undefined; // dynamic category columns
}

export interface GeoEntry {
  customer_id: string;
  customer_name: string;
  location: string;
  x_count: number;
  linkedin_count: number;
  news_count: number;
  blog_count?: number;
  total_count: number;
}

// Auth types
export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface UserInfo {
  email: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  groups?: string[];  // Make groups optional since it might be undefined
  sub: string;
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface CustomersResponse {
  success: boolean;
  count: number;
  customers: Customer[];
  filtered_by_teams: string[];
}

export interface ActivitiesResponse {
  success: boolean;
  customer_id?: string;
  source?: string;
  count: number;
  activities: Activity[];
  filters: {
    start_date: string;
    end_date: string;
    source?: string;
    limit?: number;
    filtered_by_teams: string[];
  };
}

export interface HeatmapResponse {
  success: boolean;
  date_range: {
    start_date: string;
    end_date: string;
    days: number;
  };
  group_by?: 'source' | 'category';
  columns?: string[];
  customer_count: number;
  max_values: Record<string, number>;
  heatmap: HeatmapEntry[];
}

export interface GeoResponse {
  success: boolean;
  date_range: {
    start_date: string;
    end_date: string;
    days: number;
  };
  customer_count: number;
  location_count: number;
  customers_without_location: number;
  geo_data: GeoEntry[];
}

export interface VelocityResponse {
  success: boolean;
  current_period: {
    start_date: string;
    end_date: string;
    days: number;
    total_activities: number;
  };
  previous_period: {
    start_date: string;
    end_date: string;
    days: number;
    total_activities: number;
  };
  velocity: {
    display_value: string;  // e.g., "🆕 NEW", "+162", "+500%+", "+25.5%"
    display_type: 'new' | 'absolute' | 'capped' | 'percentage';
    percent_change: number;
    absolute_change: number;
    trend: 'up' | 'down' | 'stable';
    explanation: string;  // Detailed explanation for tooltip
  };
  filtered_by_teams: string[];
  filtered_by_sources?: string[];
}

export interface HashtagEntry {
  hashtag: string;
  count: number;
  sources: {
    x?: number;
    linkedin?: number;
  };
  customers: {
    [customerName: string]: {
      count: number;
      like_count: number;
      view_count: number;
      comment_count: number;
      engagement_score: number;
      engagement_explanation: string;
    };
  };
}

export interface HashtagsResponse {
  success: boolean;
  date_range: {
    start_date: string;
    end_date: string;
    days: number;
  };
  total_unique_hashtags: number;
  total_hashtag_occurrences: number;
  top_hashtags: HashtagEntry[];
  filtered_by_teams: string[];
  filtered_by_sources?: string[];
  customer_count: number;
  query_time_ms: number;
  cache_hit: boolean;
}
