export interface AgentInfo {
  name: string;
  brand_name: string;
  logo_url: string | null;
  tagline: string;
  phone: string;
  license: string;
}

export interface PropertyInfo {
  title: string;
  address: string;
  neighborhood: string;
  city: string;
  price: number;
  rooms: number;
  size_sqm: number;
  floor: number;
  parking: number;
}

export interface GalleryImage {
  url: string;
  caption: string;
}

export interface CarouselSlide {
  num: string;
  title: string;
  body: string;
  tag: string;
}

export interface AreaStop {
  label: string;
  minutes: string;
}

export interface AreaStat {
  value: string;
  label: string;
  source_url: string | null;
}

export interface AreaInfo {
  blurb: string;
  stops: AreaStop[];
  stats: AreaStat[];
  map_image_url: string | null;
  profile_slug: string | null;
}

export interface CtaInfo {
  headline: string;
  sub: string;
  bullets: string[];
  button_label: string;
}

export type PageStatus = "building" | "active" | "expiring" | "expired" | "archived";

export interface PropertyPage {
  page_id: string;
  listing_id: string;
  business_phone: string;
  status: PageStatus;
  created_at: FirebaseFirestore.Timestamp | Date;
  updated_at: FirebaseFirestore.Timestamp | Date;
  expires_at: FirebaseFirestore.Timestamp | Date;
  reminder_sent_at: FirebaseFirestore.Timestamp | Date | null;
  extension_count: number;
  edit_count: number;
  agent: AgentInfo;
  property: PropertyInfo;
  hero: {phrase: string; video_url: string; poster_url: string | null};
  gallery: {images: GalleryImage[]};
  carousel: {slides: CarouselSlide[]};
  area: AreaInfo;
  cta: CtaInfo;
  sections: {gallery: boolean; carousel: boolean; area: boolean};
  view_count: number;
  lead_count: number;
}

export type ListingStatus = "active" | "archived" | "deleted";

export interface Listing {
  listing_id: string;
  business_phone: string;
  source: "dashboard" | "chat_burst";
  address: string;
  neighborhood: string;
  city: string;
  price: number;
  rooms: number;
  size_sqm: number;
  floor: number;
  parking: number;
  description: string;
  photos_urls: string[];
  own_video_url: string | null;
  status: ListingStatus;
  page_id: string | null;
  /** Demo/dashboard flows may carry agent data on the listing until signup exists. */
  agent: AgentInfo | null;
  created_at: FirebaseFirestore.Timestamp | Date;
}

export const PAGE_LIFESPAN_DAYS = 30;
export const REMINDER_BEFORE_DAYS = 5;

export function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
