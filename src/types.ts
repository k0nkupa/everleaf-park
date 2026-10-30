export const THEMES = {
  A: { name: "Golden Hour Fête", line: "Low golden sun, bunting and bronze." },
  B: {
    name: "Confetti Parade",
    line: "Midday sun, stripes, pennants and confetti.",
  },
  C: { name: "Lantern Bloom", line: "Blue hour, indigo sky and lantern glow." },
} as const;
export const SPECIES = {
  dog: "Dog",
  cat: "Cat",
  rabbit: "Rabbit",
  bird: "Bird",
  guinea: "Guinea pig",
  horse: "Horse",
  turtle: "Turtle",
} as const;
export const FINISHES = {
  bronze: "Bronze",
  glaze: "Glazed white",
  marble: "Marble",
} as const;
export const KEEPSAKES = [
  "Portrait",
  "Memory album",
  "Collar & tag",
  "Favourite ball",
  "Candles",
  "Flowers",
  "Framed photo",
  "Blanket",
] as const;
export type User = {
  id: string;
  email: string;
  name: string;
  moderator: boolean;
};
export type Placement = {
  kind: (typeof KEEPSAKES)[number];
  x: number;
  y: number;
};
export type Memorial = {
  id: string;
  owner_id: string;
  name: string;
  species: keyof typeof SPECIES;
  born: string;
  passed: string;
  message: string;
  theme: keyof typeof THEMES;
  setting: "house" | "garden";
  style: "stylized" | "photo";
  finish: keyof typeof FINISHES;
  visibility: "public" | "link" | "private";
  review: boolean;
  status: "draft" | "published" | "archived";
  moderated: boolean;
  portrait_id: string | null;
  arrangement: Placement[];
  version: number;
  created_at: number;
  updated_at: number;
  role: "owner" | "contributor" | "viewer" | null;
  portrait?: string;
  media?: Media[];
  memories?: Memory[];
  candles?: Candle[];
  contributors?: { name: string }[];
};
export type Media = {
  id: string;
  memorial_id: string;
  user_id: string;
  purpose: "portrait" | "album" | "reference";
  filename: string;
  path: string;
  original_path: string;
  bytes: number;
  created_at: number;
};
export type Memory = {
  id: string;
  memorial_id: string;
  user_id: string;
  author: string;
  title: string;
  story: string;
  date: string;
  media_ids: string[];
  status: "pending" | "approved" | "declined" | "hidden";
  created_at: number;
  updated_at: number;
};
export type Candle = {
  id: string;
  memorial_id: string;
  user_id: string;
  author: string;
  anonymous: boolean;
  message: string;
  created_at: number;
  expires_at: number;
};
export type Member = {
  id: string;
  email: string;
  name: string;
  role: "contributor" | "viewer";
  status: "invited" | "accepted";
  created_at: number;
};
export type Report = {
  id: string;
  memorial_id: string | null;
  memory_id: string | null;
  reporter_id: string;
  reason: string;
  detail: string;
  status: "pending" | "actioned" | "dismissed";
  decision: string;
  created_at: number;
  memorial_name?: string;
  memory_title?: string;
};
