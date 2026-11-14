using System;
using System.IO;
using System.Threading;

internal static partial class Sandbox
{
    internal sealed class Control : IDisposable {
        internal readonly EventWaitHandle Event = new EventWaitHandle(false, EventResetMode.ManualReset);
        internal readonly bool Enabled;
        internal Control(bool enabled) {
            Enabled = enabled;
            if (!enabled) return;
            Thread thread = new Thread(delegate() {
                try { Console.OpenStandardInput().ReadByte(); }
                catch (IOException) { }
                try { Event.Set(); } catch (ObjectDisposedException) { }
            });
            thread.IsBackground = true;
            thread.Start();
        }
        internal void CheckCanceled() {
            if (Enabled && Event.WaitOne(0)) throw new OperationCanceledException("Sandbox canceled before launch");
        }
        public void Dispose() { Event.Dispose(); }
    }
}
