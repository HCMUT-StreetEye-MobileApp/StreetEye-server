export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export const logger: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
};
