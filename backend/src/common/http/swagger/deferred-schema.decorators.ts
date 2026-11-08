const pending = new WeakMap<object, Array<() => void>>();

export function deferSchemaDecorator(factory: () => ClassDecorator | MethodDecorator): ClassDecorator & MethodDecorator {
  return ((target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const owner = descriptor?.value ?? target;
    const decorators = pending.get(owner) ?? [];
    decorators.push(() => {
      const decorator = factory();
      if (descriptor && key !== undefined) (decorator as MethodDecorator)(target, key, descriptor);
      else (decorator as ClassDecorator)(target as Function);
    });
    pending.set(owner, decorators);
  }) as ClassDecorator & MethodDecorator;
}

export function applyDeferredSchemaDecorators(target: object): void {
  const decorators = pending.get(target);
  while (decorators?.length) {
    decorators[0]();
    decorators.shift();
  }
  pending.delete(target);
}
