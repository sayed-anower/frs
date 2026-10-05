/* frs/src/rules/known.js — shared vocabularies for all rule modules.
 * Pure JS, no deps. Node: require('./known.js'). Browser: FRS_rules_known.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_rules_known = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Known primitive + common std types (for T005 unknown-type rule).
  // Covers prompt.txt std coverage: primitives, core smart pointers,
  // collections, sync/threading, fs/io/net/path/process/time/env/ffi.
  var KNOWN_TYPES = {
    'i8': 1, 'i16': 1, 'i32': 1, 'i64': 1, 'i128': 1, 'isize': 1,
    'u8': 1, 'u16': 1, 'u32': 1, 'u64': 1, 'u128': 1, 'usize': 1,
    'f32': 1, 'f64': 1, 'bool': 1, 'char': 1, 'str': 1, 'String': 1,
    'Vec': 1, 'Option': 1, 'Result': 1, 'Box': 1, 'Rc': 1, 'Arc': 1,
    'HashMap': 1, 'HashSet': 1, 'BTreeMap': 1, 'BTreeSet': 1, 'VecDeque': 1,
    'BinaryHeap': 1, 'LinkedList': 1,
    'Cell': 1, 'RefCell': 1, 'UnsafeCell': 1,
    'Mutex': 1, 'RwLock': 1, 'MutexGuard': 1, 'RwLockReadGuard': 1, 'RwLockWriteGuard': 1,
    'AtomicBool': 1, 'AtomicI8': 1, 'AtomicI16': 1, 'AtomicI32': 1,
    'AtomicI64': 1, 'AtomicIsize': 1, 'AtomicU8': 1, 'AtomicU16': 1,
    'AtomicU32': 1, 'AtomicU64': 1, 'AtomicUsize': 1, 'AtomicPtr': 1,
    'Ordering': 1,
    'Sender': 1, 'Receiver': 1, 'SyncSender': 1,
    'OnceLock': 1, 'LazyLock': 1, 'Once': 1,
    'Cow': 1, 'Waker': 1, 'Context': 1, 'Poll': 1, 'Pin': 1,
    'File': 1, 'OpenOptions': 1, 'Metadata': 1, 'DirEntry': 1,
    'BufReader': 1, 'BufWriter': 1, 'Cursor': 1, 'Stdin': 1, 'Stdout': 1, 'Stderr': 1,
    'TcpStream': 1, 'TcpListener': 1, 'UdpSocket': 1,
    'IpAddr': 1, 'Ipv4Addr': 1, 'Ipv6Addr': 1, 'SocketAddr': 1,
    'Path': 1, 'PathBuf': 1,
    'Command': 1, 'Child': 1, 'ExitStatus': 1, 'ExitCode': 1,
    'Thread': 1, 'JoinHandle': 1,
    'Duration': 1, 'Instant': 1, 'SystemTime': 1,
    'CString': 1, 'CStr': 1, 'OsString': 1, 'OsStr': 1,
    'NonNull': 1, 'ManuallyDrop': 1,
    'Range': 1, 'RangeInclusive': 1,
    'Hash': 1, 'Hasher': 1,
    'Error': 1,
    'Self': 1, 'self': 1,
    '()': 1, '&str': 1
  };

  // Known bare std free-functions (not macros, not methods, not paths).
  var KNOWN_FNS = {
    'drop': 1, 'forget': 1
  };

  // Known macros (anything else -> lenient pass, NOT an error).
  var KNOWN_MACROS = {
    'println': 1, 'print': 1, 'eprintln': 1, 'eprint': 1, 'format': 1,
    'vec': 1, 'panic': 1, 'assert': 1, 'assert_eq': 1, 'assert_ne': 1,
    'debug_assert': 1, 'debug_assert_eq': 1, 'debug_assert_ne': 1,
    'dbg': 1, 'todo': 1, 'unimplemented': 1, 'unreachable': 1,
    'include': 1, 'include_str': 1, 'include_bytes': 1,
    'env': 1, 'option_env': 1, 'cfg': 1, 'compile_error': 1,
    'stringify': 1, 'concat': 1, 'matches': 1,
    'file': 1, 'line': 1, 'column': 1, 'module_path': 1
  };

  return { KNOWN_TYPES: KNOWN_TYPES, KNOWN_MACROS: KNOWN_MACROS, KNOWN_FNS: KNOWN_FNS };
}));
