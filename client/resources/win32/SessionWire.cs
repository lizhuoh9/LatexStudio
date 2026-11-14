using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static partial class Sandbox
{
    internal sealed class SessionWire : IDisposable {
        internal readonly BlockingCollection<Dictionary<string, object>> Requests = new BlockingCollection<Dictionary<string, object>>(1);
        internal readonly EventWaitHandle Stop = new EventWaitHandle(false, EventResetMode.ManualReset);
        internal readonly Stopwatch Clock = Stopwatch.StartNew();
        internal string Reason = "closed";
        internal int Timeout, OutputBytes;
        readonly object gate = new object();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
        internal SessionWire(int timeout) {
            Timeout = timeout;
            Thread reader = new Thread(ReadLoop); reader.IsBackground = true; reader.Start();
        }
        internal void Cancel(string reason) { lock (gate) { if (!Stop.WaitOne(0)) { Reason = reason; Stop.Set(); } } }
        internal void Check(IntPtr parent) {
            if (WaitForSingleObject(parent, 0) == 0) Cancel("owner-exit");
            if (Clock.ElapsedMilliseconds >= Timeout) Cancel("timeout");
            if (Stop.WaitOne(0)) throw new OperationCanceledException("Session stopped");
        }
        internal int Remaining { get { return (int)Math.Max(1, Timeout - Clock.ElapsedMilliseconds); } }
        internal void Emit(object frame) {
            lock (gate) {
                try { Console.Out.WriteLine(new JavaScriptSerializer().Serialize(frame)); Console.Out.Flush(); }
                catch (IOException) { Cancel("eof"); }
                catch (ObjectDisposedException) { Cancel("eof"); }
            }
        }
        void ReadLoop() {
            try {
                using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true))) {
                    string line;
                    while ((line = ReadBounded(reader)) != null) {
                        Dictionary<string, object> frame = json.Deserialize<Dictionary<string, object>>(line);
                        object type;
                        if (frame == null || !frame.TryGetValue("type", out type) || !(type is string)) throw new IOException();
                        if ((string)type == "cancel") { Cancel(Object.Equals(frame.ContainsKey("reason") ? frame["reason"] : null, "timeout") ? "timeout" : "canceled"); return; }
                        if ((string)type != "run" && (string)type != "close") throw new IOException();
                        if (!Requests.TryAdd(frame)) throw new IOException();
                    }
                    Cancel("eof");
                }
            } catch (Exception) { Cancel("protocol-error"); }
        }
        static string ReadBounded(TextReader reader) {
            StringBuilder line = new StringBuilder();
            int value;
            while ((value = reader.Read()) != -1) {
                if (value == '\n') return line.ToString();
                if (value == '\r' || line.Length >= 16383) throw new IOException("Invalid control frame");
                line.Append((char)value);
            }
            if (line.Length != 0) throw new IOException("Truncated control frame");
            return null;
        }
        internal Task Pump(Pipe pipe, int id, string stream) {
            return Task.Factory.StartNew(delegate {
                try {
                    byte[] bytes = new byte[4096]; int count;
                    while ((count = pipe.Parent.Read(bytes, 0, bytes.Length)) > 0) {
                        if (Interlocked.Add(ref OutputBytes, count) > 2 * 1024 * 1024) { Cancel("output-limit"); return; }
                        Emit(new { type = "data", id = id, stream = stream, data = Convert.ToBase64String(bytes, 0, count) });
                    }
                } catch (IOException) { Cancel("eof"); }
                catch (ObjectDisposedException) { Cancel("eof"); }
            });
        }
        public void Dispose() { /* Reader is background and stdin lifetime belongs to the process. */ }
    }
}
