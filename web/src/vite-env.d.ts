declare module "*.css";
declare module "*?raw" {
  const src: string;
  export default src;
}
declare module "*?worker" {
  const WorkerFactory: new (options?: WorkerOptions) => Worker;
  export default WorkerFactory;
}
