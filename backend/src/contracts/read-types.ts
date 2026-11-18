export interface Position { longitude:number; latitude:number }
export interface HazardQuery {
  data_mode: string; min_longitude: number; min_latitude: number; max_longitude: number; max_latitude: number;
  longitude?: number; latitude?: number; radius_m?: number; limit?: number; cursor?: string;
}
export interface RouteInput {
  data_mode: string; route_revision: string; geometry: { type: 'LineString'; coordinates: [number, number][] };
  maneuvers: { maneuver_id: string; location: Position; approach_bearing?: number | null; exit_bearing?: number | null }[];
  offline?: boolean;
}
