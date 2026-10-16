// Example pimg plugin — copy this directory to <home>/plugins/hello/ and run:
//   pimg hello greet --name Ada
//   pimg hello sys
export const commands = {
  greet: {
    description: 'greet someone (example plugin command)',
    async run({ args, flags }) {
      const name = flags.get('name') ?? args[0] ?? 'world';
      console.log(`hello, ${name} (from the hello plugin)`);
      return 0;
    },
  },
  sys: {
    description: 'print host platform (example plugin command)',
    async run({ store }) {
      console.log(`platform=${process.platform} arch=${process.arch} home=${store.home}`);
      return 0;
    },
  },
};
