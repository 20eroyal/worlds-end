import { Vector2 } from '../types';
import { TILE_SIZE } from '../constants';

export const cartToIso = (x: number, y: number): Vector2 => {
  const isoX = (x - y) * TILE_SIZE;
  const isoY = ((x + y) * TILE_SIZE) / 2;
  return { x: isoX, y: isoY };
};

export const isoToCart = (isoX: number, isoY: number): Vector2 => {
  const y = (2 * isoY - isoX) / 2 / TILE_SIZE;
  const x = (isoX + 2 * isoY) / 2 / TILE_SIZE;
  return { x, y };
};

export const getDistance = (a: Vector2, b: Vector2) => {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
};